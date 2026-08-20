// 集成：runGateDLoop 驱动真 reviewFixLoop 引擎（codex 审 diff⇄claude 改 worktree），mock LLM/CI/git 边界。
// 锁闸D 特有不变量：①codex LGTM→resolved；②CHANGES→claude 改→CI 绿→**push**→codex LGTM→resolved；
// ③改后 CI 红 → **抛**（绝不推红进 PR，worker 据此停泊 GATE_D_FAILED）；④claude 升级 needs_human→needsHuman 出口。
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// codex 判决队列（按轮 shift）；claude ok 队列（按调用 shift，默认 ok）；CI 绿/红可控；
// worktreeClean 队列（默认 true）；commit 可控；reset/push/ci/claude 记调用。
let codexVerdicts: string[] = [];
let claudeFix = JSON.stringify({ summary: '按意见改了', needs_human: [] });
let claudeOkQueue: boolean[] = [];
let ciOk = true;
let ciRan = true;
let commitResult = { ok: true, committed: true, output: 'committed' };
let cleanQueue: boolean[] = [];
let resetOk = true;
let pushCalls = 0;
let commitCalls = 0;
let ciCalls = 0;
let claudeCalls = 0;
let resetCalls = 0;
let codexCalls = 0;
let lastCodexPrompt = ''; // 真渲染产物捕获：证明 code 喂全了模板变量（无残留 {{X}}）
let lastClaudePrompt = '';

mock.module('../src/llm/runCodex.ts', {
  namedExports: {
    runCodex: async (prompt: string) => {
      codexCalls++;
      lastCodexPrompt = prompt;
      const v = codexVerdicts.shift() ?? JSON.stringify({ verdict: 'LGTM', findings: [] });
      return { ok: true, result: v, threadId: 't-codex', tokens: { input: 1, cachedInput: 0, output: 1 }, raw: v, available: true, error: null };
    },
  },
});
mock.module('../src/llm/runClaude.ts', {
  namedExports: {
    runClaude: async (prompt: string) => {
      claudeCalls++;
      lastClaudePrompt = prompt;
      const ok = claudeOkQueue.length ? (claudeOkQueue.shift() as boolean) : true;
      return ok
        ? { ok: true, result: claudeFix, sessionId: null, costUsd: 0.01, raw: claudeFix, error: null }
        : { ok: false, result: '', sessionId: null, costUsd: null, raw: '', error: 'claude 瞬断' };
    },
  },
});
mock.module('../src/gates/ci.ts', {
  namedExports: {
    runCi: async () => { ciCalls++; return { ok: ciOk, ran: ciRan, summary: ciOk ? 'all green' : 'FAIL libs/x' }; },
    hasCommitsSince: () => true,
    diffStatSince: () => ' a.ts | 2 +-',
    changedFilesSince: () => ['a.ts'],
    commitWorktree: () => { commitCalls++; return commitResult; },
    worktreeClean: () => (cleanQueue.length ? (cleanQueue.shift() as boolean) : true),
    pushWorktree: () => { pushCalls++; return { ok: true, output: 'pushed' }; },
    resetWorktree: () => { resetCalls++; return resetOk ? { ok: true, output: '' } : { ok: false, output: 'reset boom（嵌套残留）' }; },
  },
});
mock.module('../src/util/worktree.ts', { namedExports: { worktreeHeadSha: () => 'PREHEAD' } });
const env = {
  worktree_path: '/wt', impl_branch: 'forge/x', base_ref: 'origin/main', base_sha: 'PINSHA',
  implemented: true, diff_stat: '', files_changed: [], ci_ok: true, ci_summary: '', last_summary: '',
};
mock.module('../src/gates/gateC.ts', {
  namedExports: { readImplEnvelope: () => env, persistGateC: () => {}, gateCContext: () => '技术方案：做 X' },
});
mock.module('../src/projects.ts', {
  namedExports: {
    projectForSession: () => ({ id: 'p', root: '/proj', repos: ['.'], repoPath: () => '/proj/repo', scripts: { ci: './tools/scripts/forge-ci.sh' } }),
  },
});

const sessions = await import('../src/store/sessions.ts');
const { runGateDLoop } = await import('../src/gates/gateDLoop.ts');

let n = 0;
async function mk(): Promise<string> {
  const id = `dl${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  return id;
}

beforeEach(() => {
  codexVerdicts = [];
  claudeFix = JSON.stringify({ summary: '按意见改了', needs_human: [] });
  claudeOkQueue = [];
  ciOk = true;
  ciRan = true;
  commitResult = { ok: true, committed: true, output: 'committed' };
  cleanQueue = [];
  resetOk = true;
  pushCalls = 0;
  commitCalls = 0;
  ciCalls = 0;
  claudeCalls = 0;
  resetCalls = 0;
  codexCalls = 0;
  lastCodexPrompt = '';
  lastClaudePrompt = '';
});

test('真渲染 prompt 无残留占位（code 喂全 gate-d-pr-review / gate-d-fix 模板变量；SF3 抓 code 漏喂变量）', async () => {
  codexVerdicts = [CHANGES]; // 走 review(CHANGES) → fix，两个真渲染 prompt 都被捕获
  await runGateDLoop((await sessions.get(await mk()))!);
  assert.doesNotMatch(lastCodexPrompt, /\{\{\w+\}\}/, 'codex 审 prompt 有未喂变量（code 漏喂模板变量）');
  assert.doesNotMatch(lastClaudePrompt, /\{\{\w+\}\}/, 'claude 改 prompt 有未喂变量（code 漏喂模板变量）');
});

const CHANGES = JSON.stringify({ verdict: 'CHANGES_REQUESTED', findings: [{ severity: 'high', issue: 'x', where: 'a.ts:1', fix: '', evidence: '' }] });

test('resume 轮真渲染无残留（gate-d-pr-review-resume + gate-d-fix-resume；code 喂全续接 prompt 变量，SF4 补 resume 分支）', async () => {
  // 此前真渲染断言只覆盖 initial（gate-d-pr-review/gate-d-fix）；resume 分支的「code 真喂变量」无兜底（Codex SF4）。
  // 跑满 2 tick：tick1 走 initial（pin 双侧会话），tick2 因双侧会话已存 → 走 resume（…-resume）。
  codexVerdicts = [CHANGES, CHANGES]; // 两轮都 CHANGES → 两 tick 各审一次、各改一次（CI 绿则推、暂停）
  ciOk = true;
  const id = await mk();
  await runGateDLoop((await sessions.get(id))!); // tick1：initial review + initial fix
  await runGateDLoop((await sessions.get(id))!); // tick2：resume review + resume fix
  assert.doesNotMatch(lastCodexPrompt, /\{\{\w+\}\}/, 'gate-d-pr-review-resume 有未喂变量（code 漏喂模板变量）');
  assert.doesNotMatch(lastClaudePrompt, /\{\{\w+\}\}/, 'gate-d-fix-resume 有未喂变量（code 漏喂模板变量）');
});

test('codex LGTM 首轮 → resolved（无改、不 push）', async () => {
  codexVerdicts = [JSON.stringify({ verdict: 'LGTM', findings: [] })];
  const out = await runGateDLoop((await sessions.get(await mk()))!);
  assert.equal(out.resolved, true);
  assert.equal(out.verdict, 'LGTM');
  assert.equal(commitCalls, 0); // LGTM 不触发改方
  assert.equal(pushCalls, 0);
});

test('codex CHANGES → claude 改 → CI 绿 → push（每-tick=1 本轮暂停）；下个 tick codex LGTM → resolved', async () => {
  codexVerdicts = [
    JSON.stringify({ verdict: 'CHANGES_REQUESTED', findings: [{ severity: 'high', issue: '漏失败路径', where: 'a.ts:1', fix: '', evidence: '' }] }),
    JSON.stringify({ verdict: 'LGTM', findings: [] }),
  ];
  ciOk = true;
  const id = await mk();
  const first = await runGateDLoop((await sessions.get(id))!);
  assert.equal(first.paused, true); // 每-tick=1（CI 重）：改完 + CI 绿 + 推完即暂停，下个 tick 续
  assert.ok(commitCalls >= 1); // 改方落了提交
  assert.ok(pushCalls >= 1); // CI 绿才推分支
  const second = await runGateDLoop((await sessions.get(id))!); // 下个 tick：codex 复审
  assert.equal(second.resolved, true);
  assert.equal(second.verdict, 'LGTM');
});

test('改方后 CI 持续红 → claude 有限轮自修后仍红 → 回滚 + 抛（绝不推红；CI 次数钉死 off-by-one）', async () => {
  codexVerdicts = [CHANGES];
  ciOk = false; // 每轮 CI 都红
  const id = await mk();
  await assert.rejects(async () => runGateDLoop((await sessions.get(id))!), /CI 仍红/);
  assert.equal(pushCalls, 0); // 红绝不推
  assert.equal(ciCalls, 3); // MAX_CI_FIX_ATTEMPTS=2：初始 CI + 2 轮自修后 CI = 恰 3 次（钉死终止性）
  assert.equal(claudeCalls, 3); // 初始改方 + 2 轮自修
  assert.ok(Math.abs(((await sessions.get(id))!.gate_d_cost_usd ?? 0) - 0.03) < 1e-9, '初始改方 + 2 轮自修都是真付费调用，成本必须累计可见');
  assert.equal(resetCalls, 1); // 退出前回滚到 preHead（不留红 commit）
  // gate-d-ci-fix 的 **loop 自修调用点**（gateDLoop.ts:246）真渲染兜底（Codex 二审 Nit2：此调用点此前无捕获，
  // 只有 gateDHarden 的 harden 自修调用点有）。lastClaudePrompt 此刻 = 最后一轮 gate-d-ci-fix。
  assert.doesNotMatch(lastClaudePrompt, /\{\{\w+\}\}/, 'gate-d-ci-fix（loop 自修调用点）有未喂变量（code 漏喂 CI/WORKTREE）');
});

test('改方后 CI 跑不起来（基础设施）→ 回滚 + 抛（停泊，不推、不自修）', async () => {
  codexVerdicts = [CHANGES];
  ciRan = false;
  await assert.rejects(async () => runGateDLoop((await sessions.get(await mk()))!), /CI 跑不起来/);
  assert.equal(pushCalls, 0);
  assert.equal(resetCalls, 1);
});

test('Blocker：commit 失败（worktree 可能脏）→ 回滚 + 抛，且绝不跑 CI / push', async () => {
  codexVerdicts = [CHANGES];
  commitResult = { ok: false, committed: false, output: 'commit boom' };
  await assert.rejects(async () => runGateDLoop((await sessions.get(await mk()))!), /落提交失败/);
  assert.equal(ciCalls, 0); // 脏树绝不跑 CI
  assert.equal(pushCalls, 0); // 绝不推
  assert.equal(resetCalls, 1);
});

test('Blocker：提交后（CI 前）worktree 非 clean → 回滚 + 抛，绝不跑 CI / push', async () => {
  codexVerdicts = [CHANGES];
  cleanQueue = [false]; // commit 后即脏
  await assert.rejects(async () => runGateDLoop((await sessions.get(await mk()))!), /CI 须验 HEAD/);
  assert.equal(ciCalls, 0);
  assert.equal(pushCalls, 0);
  assert.equal(resetCalls, 1);
});

test('Blocker：CI 绿但 CI 自身把 worktree 改脏 → 回滚 + 抛，绝不 push（CI 验的对象 ≠ push 的 HEAD）', async () => {
  codexVerdicts = [CHANGES];
  ciOk = true;
  cleanQueue = [true, false]; // CI 前 clean、CI 后被 CI 脚本改脏（codegen/format）
  await assert.rejects(async () => runGateDLoop((await sessions.get(await mk()))!), /CI 后 worktree 被改脏/);
  assert.equal(ciCalls, 1);
  assert.equal(pushCalls, 0); // 绝不推「CI 验的不是 HEAD」的东西
  assert.equal(resetCalls, 1);
});

test('Blocker：CI 红后自修 claude 瞬断 → 回滚 + paused（绝不把红 commit 留在 HEAD 供下 tick LGTM）', async () => {
  codexVerdicts = [CHANGES];
  ciOk = false; // 初始 CI 红 → 触发自修
  claudeOkQueue = [true, false]; // 初始改方 ok、自修 claude 瞬断
  const out = await runGateDLoop((await sessions.get(await mk()))!);
  assert.equal(out.paused, true); // 瞬断 → 引擎暂停重试（不推进 round）
  assert.equal(pushCalls, 0);
  assert.equal(resetCalls, 1); // 回滚到 preHead：下 tick review-first 看到的是上一个绿 HEAD，不会 LGTM 红改动
});

test('no-op 改方（无改动·worktree clean）+ CI 绿 → 不抛、可推（HEAD 即 CI 验过的提交）', async () => {
  codexVerdicts = [CHANGES];
  commitResult = { ok: true, committed: false, output: '无改动' }; // claude 没改文件
  ciOk = true; // cleanQueue 默认全 true（CI 前后都干净）
  const first = await runGateDLoop((await sessions.get(await mk()))!); // 每-tick=1 → 改方一轮后暂停
  assert.equal(first.paused, true);
  assert.ok(ciCalls >= 1 && pushCalls >= 1); // CI 验 HEAD、推 HEAD（无 mismatch）
});

test('Blocker：改方需回滚但 resetWorktree 失败 → 落毒丸 gate_d_rollback_to + 抛（worktree 未确认复位，交守门）', async () => {
  const id = await mk();
  await sessions.patch(id, { worktree_path: '/wt' });
  codexVerdicts = [CHANGES];
  ciOk = false; // CI 持续红 → 自修耗尽 → bail → rollback
  resetOk = false; // 回滚本身失败
  await assert.rejects(async () => runGateDLoop((await sessions.get(id))!), /回滚 worktree 到 .* 失败/);
  assert.equal(pushCalls, 0); // 绝不推
  assert.equal(resetCalls, 1); // 试图回滚一次
  assert.equal((await sessions.get(id))!.gate_d_rollback_to, 'PREHEAD'); // 落毒丸 = fix 入口 HEAD（worktreeHeadSha mock）
});

test('Blocker：上轮回滚失败留毒丸（gate_d_rollback_to）→ 进 loop 先强制复位；复位仍失败 → 抛，绝不进 review-first', async () => {
  // 这是 Codex 三审 Blocker 的回归：回滚失败 → 停泊 GATE_D_FAILED → planRetry 把已开 PR 的它送回 GATE_D_LOOP。
  // 若进 loop 不先复位确认，红/脏 HEAD 就被 codex review-first 直接 LGTM 绕过 CI 闸。
  const id = await mk();
  await sessions.patch(id, { gate_d_rollback_to: 'GREENSHA', worktree_path: '/wt' });
  resetOk = false; // 复位再次失败
  codexVerdicts = [JSON.stringify({ verdict: 'LGTM', findings: [] })]; // 即便 codex 想 LGTM 也不该被调到
  await assert.rejects(async () => runGateDLoop((await sessions.get(id))!), /回滚恢复失败/);
  assert.equal(codexCalls, 0); // 复位没确认 → review-first 绝不跑（红/脏 HEAD 不得进 review）
  assert.equal(resetCalls, 1); // 进 loop 先复位一次
  assert.equal((await sessions.get(id))!.gate_d_rollback_to, 'GREENSHA'); // 毒丸保留 → 下次 retry 仍守门，不靠错误分类放行
});

test('回滚毒丸：进 loop 复位确认成功 → 清毒丸、放行 review-first（codex LGTM → resolved）', async () => {
  const id = await mk();
  await sessions.patch(id, { gate_d_rollback_to: 'GREENSHA', worktree_path: '/wt' });
  resetOk = true; // 复位确认成功
  codexVerdicts = [JSON.stringify({ verdict: 'LGTM', findings: [] })];
  const out = await runGateDLoop((await sessions.get(id))!);
  assert.equal(out.resolved, true);
  assert.equal(resetCalls, 1); // 复位确认一次
  assert.ok(codexCalls >= 1); // 复位确认后才放行 review
  assert.equal((await sessions.get(id))!.gate_d_rollback_to, null); // 复位成功 → 毒丸清除
});

test('claude 改方升级 needs_human → needsHuman 出口（CI 绿、已推）', async () => {
  codexVerdicts = [CHANGES];
  claudeFix = JSON.stringify({ summary: '改了但有取舍要拍板', needs_human: [{ id: 'H1', question: '改契约还是改实现？', options: [], context: '', severity: 'high' }] });
  ciOk = true;
  const out = await runGateDLoop((await sessions.get(await mk()))!);
  assert.ok(out.needsHuman && out.needsHuman.length === 1);
  assert.ok(pushCalls >= 1); // 改动已落 + CI 绿 → 推；升级的是决策不是阻断
});
