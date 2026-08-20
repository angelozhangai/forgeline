// 集成：runGateDHarden（闸D 测试补强）。mock LLM/CI/git 边界，锁补强不变量：
// ①happy：reset 到 **pin 的绿态 sha**（绝不用移动 ref）→harden→commit→CI 绿→pin verified_sha→写报告→推；
// ②CI 红→有限轮自修→绿；③持续红→回滚(到 pin 绿态)+抛；④幂等 fast-path：merge_readiness_path 在且 HEAD==verified 且干净→只补推；
// ⑤fast-path HEAD≠verified→**绝不盲推**，落全量补强重来；⑥缺 pin 绿态 sha→抛（不在未知基线上补强）；
// ⑦规范化 reset 失败→抛；⑧harden claude 失败→回滚+抛；⑨CI 绿写报告后 push 失败→抛但不回滚（verified_sha 留存供幂等补推）。
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let claudeFix = JSON.stringify({ summary: '补了失败路径 + 权限路径测试', needs_human: [] });
let claudeOkQueue: boolean[] = [];
let ciOkQueue: boolean[] = [];
let ciRan = true;
let commitResult = { ok: true, committed: true, output: 'committed' };
let cleanQueue: boolean[] = [];
let resetOk = true;
let pushOk = true;
let headQueue: string[] = []; // worktreeHeadSha 按调用 shift；空则用 headDefault
let headDefault = 'GREENHEAD';
let resetArgs: string[] = [];
let pushCalls = 0;
let commitCalls = 0;
let ciCalls = 0;
let claudeCalls = 0;
let resetCalls = 0;

let lastClaudePrompt = ''; // 真渲染产物捕获（证明 code 喂全 gate-d-harden-tests / gate-d-ci-fix 模板变量）
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

const DELIVERY = mkdtempSync(join(tmpdir(), 'forge-mr-'));

mock.module('../src/gates/ci.ts', {
  namedExports: {
    runCi: async () => {
      ciCalls++;
      const ok = ciOkQueue.length ? (ciOkQueue.shift() as boolean) : true;
      return { ok, ran: ciRan, summary: ok ? 'all green' : 'FAIL libs/x' };
    },
    hasCommitsSince: () => true,
    diffStatSince: () => ' a.ts | 2 +-',
    changedFilesSince: () => ['a.ts'],
    commitWorktree: () => { commitCalls++; return commitResult; },
    worktreeClean: () => (cleanQueue.length ? (cleanQueue.shift() as boolean) : true),
    pushWorktree: () => { pushCalls++; return { ok: pushOk, output: pushOk ? 'pushed' : 'push boom' }; },
    resetWorktree: (_wt: string, sha: string) => { resetCalls++; resetArgs.push(sha); return resetOk ? { ok: true, output: '' } : { ok: false, output: 'reset boom' }; },
  },
});
mock.module('../src/util/worktree.ts', { namedExports: { worktreeHeadSha: () => (headQueue.length ? (headQueue.shift() as string) : headDefault) } });

const env = {
  worktree_path: '/wt', impl_branch: 'forge/x', base_ref: 'origin/main', base_sha: 'PINSHA',
  implemented: true, diff_stat: ' a.ts | 2 +-', files_changed: ['a.ts'], ci_ok: true, ci_summary: '', last_summary: '',
};
mock.module('../src/gates/gateC.ts', {
  namedExports: { readImplEnvelope: () => env, persistGateC: () => {}, gateCContext: () => '技术方案：做 X' },
});
mock.module('../src/projects.ts', {
  namedExports: {
    projectForSession: () => ({ id: 'p', root: '/proj', repos: ['.'], repoPath: () => '/proj/repo', deliveryDir: DELIVERY, scripts: { ci: './tools/scripts/forge-ci.sh' } }),
  },
});

const sessions = await import('../src/store/sessions.ts');
const { runGateDHarden, buildMergeReadiness } = await import('../src/gates/gateDHarden.ts');
const { mkLeg } = await import('../src/gates/legs.ts');

let n = 0;
async function mk(extra: Record<string, unknown> = {}): Promise<string> {
  const id = `dh${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  await sessions.patch(id, { gate_d_green_sha: 'GREENHEAD', ...extra } as never); // 默认有 pin 绿态；测试可覆盖/置 null
  return id;
}

beforeEach(() => {
  claudeFix = JSON.stringify({ summary: '补了失败路径 + 权限路径测试', needs_human: [] });
  claudeOkQueue = [];
  ciOkQueue = [];
  ciRan = true;
  commitResult = { ok: true, committed: true, output: 'committed' };
  cleanQueue = [];
  resetOk = true;
  pushOk = true;
  headQueue = [];
  headDefault = 'GREENHEAD';
  resetArgs = [];
  pushCalls = 0;
  commitCalls = 0;
  ciCalls = 0;
  claudeCalls = 0;
  resetCalls = 0;
  lastClaudePrompt = '';
});

test('happy：reset 到 pin 绿态 sha（绝不用移动 ref）→harden→CI 绿→pin verified_sha→写报告→推', async () => {
  const id = await mk();
  await runGateDHarden((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(resetArgs[0], 'GREENHEAD'); // 关键回归：基线是 pin 的 sha，不是 origin/forge/x
  assert.ok(!resetArgs.some((a) => a.startsWith('origin/'))); // 绝不 reset 到移动 ref
  assert.equal(s.gate_d_harden_verified_sha, 'GREENHEAD'); // pin 下被验证的 HEAD
  assert.ok(s.merge_readiness_path && existsSync(s.merge_readiness_path)); // 报告落盘（forge 本地）
  assert.equal(s.gate_d_harden_round, 1);
  assert.equal(claudeCalls, 1);
  assert.equal(ciCalls, 1);
  assert.equal(pushCalls, 1);
  assert.match(readFileSync(s.merge_readiness_path!, 'utf8'), /严禁自动合并/);
  assert.doesNotMatch(lastClaudePrompt, /\{\{\w+\}\}/, 'gate-d-harden-tests 真渲染有未喂变量（code 漏喂模板变量）');
});

test('CI 红 → 有限轮自修 → 绿', async () => {
  const id = await mk();
  ciOkQueue = [false, true];
  claudeOkQueue = [true, true];
  await runGateDHarden((await sessions.get(id))!);
  assert.equal(claudeCalls, 2);
  assert.equal(ciCalls, 2);
  assert.equal(pushCalls, 1);
  assert.ok(Math.abs(((await sessions.get(id))!.gate_d_cost_usd ?? 0) - 0.02) < 1e-9, '补强首轮 + CI 红后自修都是真付费调用，成本必须累计可见');
  assert.ok((await sessions.get(id))!.merge_readiness_path);
  assert.doesNotMatch(lastClaudePrompt, /\{\{\w+\}\}/, 'gate-d-ci-fix 真渲染有未喂变量（自修轮次的 prompt）');
});

test('CI 持续红 → 有限轮自修后仍红 → 回滚(到 pin 绿态)+抛（不推）', async () => {
  const id = await mk();
  ciOkQueue = [false, false, false];
  const s = (await sessions.get(id))!;
  await assert.rejects(() => runGateDHarden(s), /CI 仍红/);
  assert.equal(ciCalls, 3);
  assert.equal(claudeCalls, 3);
  assert.ok(Math.abs(((await sessions.get(id))!.gate_d_cost_usd ?? 0) - 0.03) < 1e-9, '即使最终停泊，已发生的补强/自修付费调用也要累计到账');
  assert.equal(pushCalls, 0);
  assert.deepEqual(resetArgs, ['GREENHEAD', 'GREENHEAD']); // 入口规范化 + 退出回滚都到 pin 绿态
});

test('幂等 fast-path：merge_readiness_path 在 + HEAD==verified + 干净 → 只补推（不 harden/CI/reset）', async () => {
  const id = await mk({ merge_readiness_path: '/tmp/already.md', gate_d_harden_verified_sha: 'GREENHEAD', gate_d_harden_round: 1 });
  headDefault = 'GREENHEAD'; // HEAD == verified
  await runGateDHarden((await sessions.get(id))!);
  assert.equal(claudeCalls, 0);
  assert.equal(ciCalls, 0);
  assert.equal(resetCalls, 0);
  assert.equal(pushCalls, 1); // 仅补推已验证提交
});

test('fast-path HEAD≠verified（隔离树被改/残留）→ 绝不盲推，落全量补强重来（reset 回 pin 绿态）', async () => {
  const id = await mk({ merge_readiness_path: '/tmp/already.md', gate_d_harden_verified_sha: 'VHEAD', gate_d_harden_round: 1 });
  headQueue = ['OTHER']; // fast-path 守门：当前 HEAD=OTHER ≠ verified VHEAD → 不走 fast-path
  // 后续（reset 后、CI 绿后）worktreeHeadSha 回落 headDefault='GREENHEAD'
  await runGateDHarden((await sessions.get(id))!);
  assert.ok(claudeCalls >= 1); // 走了全量补强（fast-path 会 claudeCalls=0）——证明没盲推
  assert.equal(resetArgs[0], 'GREENHEAD'); // 重来 reset 到 pin 绿态
  assert.equal(pushCalls, 1); // 全量补强后才推（验证过的）
});

test('缺 pin 绿态 sha → 抛（拒绝在未知/移动基线上补强；不 reset/harden）', async () => {
  const id = await mk({ gate_d_green_sha: null });
  const s = (await sessions.get(id))!;
  await assert.rejects(() => runGateDHarden(s), /缺 pin 的绿态 sha/);
  assert.equal(resetCalls, 0);
  assert.equal(claudeCalls, 0);
});

test('规范化 reset 到绿态失败 → 抛（绝不在残留树上 harden）', async () => {
  const id = await mk();
  resetOk = false;
  const s = (await sessions.get(id))!;
  await assert.rejects(() => runGateDHarden(s), /规范化到绿态 .* 失败/);
  assert.equal(claudeCalls, 0);
  assert.equal(ciCalls, 0);
  assert.equal(pushCalls, 0);
  assert.equal(resetCalls, 1);
});

test('harden claude 失败 → 回滚 + 抛（不 commit/CI/推）', async () => {
  const id = await mk();
  claudeOkQueue = [false];
  const s = (await sessions.get(id))!;
  await assert.rejects(() => runGateDHarden(s), /补强 claude 失败/);
  assert.equal(commitCalls, 0);
  assert.equal(ciCalls, 0);
  assert.equal(pushCalls, 0);
  assert.deepEqual(resetArgs, ['GREENHEAD', 'GREENHEAD']); // 规范化 + 回滚
});

test('CI 绿写报告后 push 失败 → 抛但**不回滚**（verified_sha+报告留存供幂等补推）', async () => {
  const id = await mk();
  pushOk = false;
  const sess = (await sessions.get(id))!;
  await assert.rejects(() => runGateDHarden(sess), /推分支失败/);
  const s = (await sessions.get(id))!;
  assert.equal(s.gate_d_harden_verified_sha, 'GREENHEAD'); // 已 pin
  assert.ok(s.merge_readiness_path); // 报告已写
  assert.equal(resetCalls, 1); // 仅入口规范化——报告写后不回滚（绝不丢已验证工作）
  assert.equal(pushCalls, 1);
});

test('多仓补强：每个 PR 保留独立合并就绪报告，后一个仓不会覆盖前一个仓', async () => {
  const id = await mk({
    legs: JSON.stringify([
      mkLeg('demo', { worktree_path: '/wt/demo', pr_url: 'https://x/pull/11' }),
      mkLeg('example-web', { worktree_path: '/wt/example-web', pr_url: 'https://x/pull/22' }),
    ]),
    worktree_path: '/wt/demo',
    base_shas: JSON.stringify({ demo: 'PINSHA' }),
    pr_url: 'https://x/pull/11',
    pr_number: 11,
  });

  await runGateDHarden((await sessions.get(id))!);
  const firstPath = (await sessions.get(id))!.merge_readiness_path!;
  const firstText = readFileSync(firstPath, 'utf8');
  assert.match(firstPath, /merge-readiness\.demo\.md$/);
  assert.match(firstText, /https:\/\/x\/pull\/11/);

  await sessions.patch(id, {
    worktree_path: '/wt/example-web',
    base_shas: JSON.stringify({ 'example-web': 'PINSHA' }),
    pr_url: 'https://x/pull/22',
    pr_number: 22,
    gate_d_harden_round: null,
    gate_d_harden_verified_sha: null,
    merge_readiness_path: null,
  });
  await runGateDHarden((await sessions.get(id))!);
  const secondPath = (await sessions.get(id))!.merge_readiness_path!;
  const secondText = readFileSync(secondPath, 'utf8');

  assert.notEqual(firstPath, secondPath, '多仓合并证据必须每仓独立，不能共用同一路径被后仓覆盖');
  assert.match(secondPath, /merge-readiness\.example-web\.md$/);
  assert.match(readFileSync(firstPath, 'utf8'), /https:\/\/x\/pull\/11/, '第一仓报告仍保留自己的 PR');
  assert.match(secondText, /https:\/\/x\/pull\/22/, '第二仓报告记录自己的 PR');
});

test('buildMergeReadiness：含 PR / 改动 / 回滚方案 / 严禁自动合并（纯函数）', () => {
  const s = { slug: 'x', title: '做个功能', branch: 'main', pr_url: 'https://x/pull/9', gate_d_residual: null } as never;
  const md = buildMergeReadiness(s, env as never, { context: '需求：做 X', codexRound: 2, hardenSummary: '补了失败路径测试' });
  assert.match(md, /https:\/\/x\/pull\/9/);
  assert.match(md, /严禁自动合并/);
  assert.match(md, /回滚方案/);
  assert.match(md, /a\.ts/);
  assert.match(md, /第 2 轮 codex LGTM/);
});
