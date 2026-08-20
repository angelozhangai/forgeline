// 集成：runGateCLoop 驱动真 reviewFixLoop 引擎（**reviewer = 确定性 CI，非 codex**；fixer = claude 改 worktree）。
// mock LLM/CI/git/项目边界，用真 sessions(:memory:) + 真 render/strictParse/config/引擎。锁闸C 特有不变量：
//  ① 未实现（base 后无提交）→ 直接判 unimplemented、**不跑 CI**（不浪费 CI 在空树，逼 claude 动工）；
//  ② 实现→CI 绿→LGTM→resolved，且 diff/files 由 forge **现场从 git 重建**（绝不信模型文本——被对抗的是 worktree 状态）；
//  ③ CI 红 → 失败摘要回喂 claude 续修（实现⇄CI 闭环）；④ 续修轮走 resume prompt；
//  ⑤ CI 跑不起来（ran=false 基础设施错）→ **抛停泊**，绝不当成红让 claude 白改一轮；
//  ⑥ CI 绿但 CI 自身改脏 worktree（green-but-dirty）→ 抛（对 HEAD 假阳性，绝不放行）；
//  ⑦ commit 失败 / 提交后非 clean → 抛（绝不带脏树跑 CI——CI 须验 HEAD）；⑧ claude 瞬断→paused 不 commit；
//  ⑨ claude 升级 needs_human→needsHuman 出口；⑩ REVISION：负责人答复 fix-first 落实后清 pending；
//  ⑪ 到硬上限仍不绿→stalled + 残留落 gate_c_residual（交 M 裁决，绝不静默放行）。
//  另：真渲染产物捕获断言无残留 {{X}}——证明 code 真喂全 gate-c-implement / gate-c-fix-resume 模板变量（SF3 抓 code 漏喂，闭口子①）。
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// 按模板「## 段标题」抽该段正文（到下一个 ## 或结尾）：断言变量落在**正确段落**，而非 prompt 里随便哪出现——
// 抓「变量互换」（如 FINDINGS↔WORKTREE 互调时全局匹配仍绿、分段匹配必红，Codex 二审 SF5）。
function section(prompt: string, heading: string): string {
  const i = prompt.indexOf(heading);
  if (i < 0) return '';
  const after = prompt.slice(i + heading.length);
  const next = after.indexOf('\n## ');
  return next < 0 ? after : after.slice(0, next);
}
// intro = 第一个 ## 之前的正文（resume 模板把 {{WORKTREE}} 放开头、不在某个 ## 段下）。
function intro(prompt: string): string {
  const i = prompt.indexOf('\n## ');
  return i < 0 ? prompt : prompt.slice(0, i);
}

let claudeFix = JSON.stringify({ summary: '实现了登录态持久化', needs_human: [] });
let claudeTextQueue: string[] = []; // runClaude.result 文本队列（按调用 shift；空→claudeFix）。用于坏 JSON 自愈
let claudeOkQueue: boolean[] = []; // runClaude.ok 队列（按调用 shift；空→true）
let ciOkQueue: boolean[] = []; // runCi.ok 队列（按调用 shift；空→ciOkDefault）
let ciOkDefault = true;
let ciRan = true;
let commitResult = { ok: true, committed: true, output: 'committed' };
let commitQueue: { ok: boolean; committed: boolean; output: string }[] = []; // commitWorktree 队列（按调用 shift；空→commitResult）
let cleanQueue: boolean[] = []; // worktreeClean 队列（按调用 shift；空→cleanDefault）
let cleanDefault = true;
let hasCommits = false; // hasCommitsSince 标志；commit 成功后翻 true（模拟「实现落了提交」）
let claudeCalls = 0;
let ciCalls = 0;
let commitCalls = 0;
let lastClaudePrompt = ''; // 真渲染产物（证明 code 喂全 gate-c-* 模板变量）
let lastPersisted: Record<string, unknown> | null = null; // persistArtifact 落的信封（验 forge 现场重建 diff/files）
// 第二参数捕获（Codex SF1/SF2）：mock 不看入参 → 测试只验 prompt 文本，抓不住「driver 漏传/传错 sessionId/resume/cwd/base」的 wiring 退化。
let claudeOptsLog: { sessionId: string | null; resume: string | null; cwd: string | undefined }[] = [];
let ciArgsLog: { wt: string; script: string | undefined; base: string | undefined }[] = [];

mock.module('../src/llm/runClaude.ts', {
  namedExports: {
    runClaude: async (prompt: string, opts: { sessionId?: string; resume?: string; cwd?: string } = {}) => {
      claudeCalls++;
      lastClaudePrompt = prompt;
      claudeOptsLog.push({ sessionId: opts.sessionId ?? null, resume: opts.resume ?? null, cwd: opts.cwd });
      const ok = claudeOkQueue.length ? (claudeOkQueue.shift() as boolean) : true;
      const text = claudeTextQueue.length ? (claudeTextQueue.shift() as string) : claudeFix;
      return ok
        ? { ok: true, result: text, sessionId: null, costUsd: 0.01, raw: text, error: null }
        : { ok: false, result: '', sessionId: null, costUsd: null, raw: '', error: 'claude 瞬断' };
    },
  },
});
mock.module('../src/gates/ci.ts', {
  namedExports: {
    runCi: async (wt: string, script: string | undefined, opts: { base?: string } = {}) => {
      ciCalls++;
      ciArgsLog.push({ wt, script, base: opts?.base });
      const ok = ciOkQueue.length ? (ciOkQueue.shift() as boolean) : ciOkDefault;
      return { ok, ran: ciRan, summary: ok ? 'all green' : 'FAIL libs/x 测试未过' };
    },
    hasCommitsSince: () => hasCommits,
    diffStatSince: () => ' libs/a.ts | 10 ++++',
    changedFilesSince: () => ['libs/a.ts'],
    commitWorktree: () => {
      commitCalls++;
      const r = commitQueue.length ? (commitQueue.shift() as { ok: boolean; committed: boolean; output: string }) : commitResult;
      if (r.ok && r.committed) hasCommits = true; // 真落了提交 = base..HEAD 自此有提交（no-op committed:false 不翻）
      return r;
    },
    worktreeClean: () => (cleanQueue.length ? (cleanQueue.shift() as boolean) : cleanDefault),
  },
});
const env = {
  worktree_path: '/wt', impl_branch: 'forge/x', base_ref: 'origin/main', base_sha: 'PINSHA',
  implemented: false, diff_stat: '', files_changed: [], ci_ok: false, ci_summary: '', last_summary: '',
};
mock.module('../src/gates/gateC.ts', {
  namedExports: {
    readImplEnvelope: () => env,
    persistGateC: (_s: unknown, e: Record<string, unknown>) => { lastPersisted = e; },
    gateCContext: () => '技术方案：实现登录态持久化。外环验收：AC1 登录后刷新仍在线（当前红）',
  },
});
mock.module('../src/projects.ts', {
  namedExports: {
    projectForSession: () => ({ id: 'p', root: '/proj', repos: ['.'], repoPath: () => '/proj/repo', scripts: { ci: './tools/scripts/forge-ci.sh' } }),
  },
});

const sessions = await import('../src/store/sessions.ts');
const { runGateCLoop } = await import('../src/gates/gateCLoop.ts');

let n = 0;
async function mk(extra: Record<string, unknown> = {}): Promise<string> {
  const id = `cl${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  await sessions.patch(id, { worktree_path: '/wt', impl_branch: 'forge/x', base_shas: JSON.stringify({ '.': 'PINSHA' }), ...extra } as never);
  return id;
}

beforeEach(() => {
  claudeFix = JSON.stringify({ summary: '实现了登录态持久化', needs_human: [] });
  claudeTextQueue = [];
  claudeOkQueue = [];
  ciOkQueue = [];
  ciOkDefault = true;
  ciRan = true;
  commitResult = { ok: true, committed: true, output: 'committed' };
  commitQueue = [];
  cleanQueue = [];
  cleanDefault = true;
  hasCommits = false;
  claudeCalls = 0;
  ciCalls = 0;
  commitCalls = 0;
  lastClaudePrompt = '';
  lastPersisted = null;
  claudeOptsLog = [];
  ciArgsLog = [];
});

test('未实现（base 后无提交）→ 判 unimplemented、**不跑 CI** 逼 claude 动工；gate-c-implement 真渲染无残留占位（SF3 闭口子①）', async () => {
  const out = await runGateCLoop((await sessions.get(await mk()))!);
  assert.equal(ciCalls, 0); // 空树不浪费 CI——unimplemented 短路在 runCi 之前
  assert.equal(claudeCalls, 1); // 直接逼 claude 实现
  assert.equal(commitCalls, 1); // claude 写码后 forge 落提交
  assert.equal(out.paused, true); // 每-tick=1（CI 重）：实现一轮即暂停，下个 tick 再过 CI
  assert.doesNotMatch(lastClaudePrompt, /\{\{\w+\}\}/, 'gate-c-implement 真渲染有未喂变量（code 漏喂模板变量）');
  // 分段哨兵（Codex 二审 SF5）：无残留 {{X}} 只抓「漏喂」，全局匹配抓不住「喂错/互换」。断值落在**正确段落**：
  assert.match(section(lastClaudePrompt, '## Workspace'), /\/wt/, 'WORKTREE 须落在「Workspace」段');
  assert.match(section(lastClaudePrompt, '## What to implement'), /技术方案：实现登录态持久化/, 'CONTEXT 须落在「What to implement」段');
  assert.doesNotMatch(section(lastClaudePrompt, '## Workspace'), /技术方案：实现登录态持久化/, 'CONTEXT 串进 Workspace 段=变量互换，必红');
  // 防注入护栏必须随 prompt 渲染出来（不可信需求文本→预批 Bash 的写码 claude，护栏不能被静默删掉）。
  assert.match(lastClaudePrompt, /[Ss]ecurity boundary/, 'gate-c-implement 必须带防注入安全边界');
  assert.match(lastClaudePrompt, /untrusted data/, '护栏须明确把上下文标为不可信数据');
});

test('happy（2 tick）：实现→CI 绿→LGTM→resolved；diff/files 由 forge 现场从 git 重建（不信模型文本）', async () => {
  const id = await mk();
  const first = await runGateCLoop((await sessions.get(id))!); // tick1：unimplemented→实现→暂停（commit 翻 hasCommits）
  assert.equal(first.paused, true);
  // 关键回归（不变量⑥）：信封的 diff_stat/files_changed/implemented 来自 git 现场（diffStatSince/changedFilesSince/hasCommitsSince），
  // 绝非 claude JSON——claude 只回 summary。
  assert.equal(lastPersisted!.implemented, true);
  assert.equal(lastPersisted!.diff_stat, ' libs/a.ts | 10 ++++');
  assert.deepEqual(lastPersisted!.files_changed, ['libs/a.ts']);
  assert.equal(lastPersisted!.last_summary, '实现了登录态持久化'); // 唯一来自模型文本的字段

  const second = await runGateCLoop((await sessions.get(id))!); // tick2：HEAD 已有提交→跑 CI→绿
  assert.equal(second.resolved, true);
  assert.equal(second.verdict, 'LGTM');
  assert.equal(ciCalls, 1); // tick1 未跑 CI（unimplemented）；tick2 才真跑一次
  // CI 真跑在 worktree + 用 pin 的 base_sha（Codex SF2；防漏传 base / 传成移动 ref / 脚本路径 resolve 错——
  // ciBase 纯函数对了不代表 driver 接对了）。
  assert.deepEqual(ciArgsLog[0], { wt: '/wt', script: '/wt/tools/scripts/forge-ci.sh', base: 'PINSHA' });
});

test('CI 红 → 失败摘要回喂 claude 续修 → 绿 → resolved（实现⇄CI 闭环）', async () => {
  const id = await mk();
  hasCommits = true; // 已实现（如续做）；reviewer 直接过 CI
  ciOkQueue = [false, true]; // tick1 红、tick2 绿
  const first = await runGateCLoop((await sessions.get(id))!);
  assert.equal(first.paused, true);
  assert.match(lastClaudePrompt, /FAIL libs\/x/, 'CI 失败摘要必须回喂 claude（否则它不知道哪红了）');
  assert.deepEqual(ciArgsLog[0], { wt: '/wt', script: '/wt/tools/scripts/forge-ci.sh', base: 'PINSHA' }); // CI 跑在 worktree + pin base（SF2）
  const second = await runGateCLoop((await sessions.get(id))!);
  assert.equal(second.resolved, true);
  assert.equal(second.verdict, 'LGTM');
});

test('续修轮：真 resume 同一 fixer 会话（非每次新开）+ gate-c-fix-resume 真渲染喂全变量', async () => {
  const id = await mk();
  hasCommits = true;
  ciOkDefault = false; // 两轮都红 → 两 tick 各一次 fix
  await runGateCLoop((await sessions.get(id))!); // tick1：fix#1（initial，pin 新 fixer 会话）
  await runGateCLoop((await sessions.get(id))!); // tick2：fix#2（resume，因 fixer 会话已存）
  // 真 resume 续接（Codex SF1）：首轮 pin 新 sessionId（无 resume）；次轮 resume === 落库的 fixer 会话，cwd=worktree。
  // 若 driver 退化成每轮新开 Claude session（但仍渲染 resume prompt），下面的断言会红——光验 prompt 文本抓不住。
  const fixer = (await sessions.get(id))!.gate_c_fixer_session;
  assert.ok(fixer, 'fixer 会话必须被 pin 落库');
  assert.equal(claudeOptsLog[0].sessionId, fixer); // 首轮：新会话即落库那个
  assert.equal(claudeOptsLog[0].resume, null); // 首轮不 resume
  assert.equal(claudeOptsLog[0].cwd, '/wt'); // 改码必须在隔离 worktree
  assert.equal(claudeOptsLog[1].resume, fixer); // 次轮：resume 同一会话（续上下文，不丢前轮）
  assert.equal(claudeOptsLog[1].cwd, '/wt');
  assert.doesNotMatch(lastClaudePrompt, /\{\{\w+\}\}/, 'gate-c-fix-resume 真渲染有未喂变量');
  // 分段哨兵（SF5）：抓变量互换——FINDINGS 落「Feedback to address this round」段、WORKTREE 落开头 intro。
  assert.match(section(lastClaudePrompt, '## Feedback to address this round'), /FAIL libs\/x/, 'FINDINGS 须落在「Feedback to address this round」段');
  assert.match(intro(lastClaudePrompt), /\/wt/, 'WORKTREE 须在 intro（resume 模板开头）');
  assert.doesNotMatch(section(lastClaudePrompt, '## Feedback to address this round'), /\/wt/, 'worktree 路径串进反馈段=互换，必红');
});

test('CI 跑不起来（ran=false 基础设施错）→ 抛停泊；绝不当成红让 claude 白改一轮', async () => {
  const id = await mk();
  hasCommits = true; // 已实现 → review 直接过 CI
  ciRan = false; // 脚本缺失/spawn 失败/超时
  const s = (await sessions.get(id))!;
  await assert.rejects(() => runGateCLoop(s)); // 引擎据 review ok:false 抛 → worker 停泊 GATE_C_FAILED
  assert.equal(claudeCalls, 0); // 基础设施错 ≠ 红：绝不触发改方
  assert.equal(commitCalls, 0);
});

test('CI 绿但 CI 自身改脏 worktree（green-but-dirty）→ 抛停泊（对 HEAD 假阳性，绝不放行）', async () => {
  const id = await mk();
  hasCommits = true;
  ciOkQueue = [true]; // CI 退 0
  cleanQueue = [false]; // 但 CI 跑后 worktree 脏（codegen/format 改了 tracked 文件）
  const s = (await sessions.get(id))!;
  await assert.rejects(() => runGateCLoop(s), /改脏了 worktree/);
  assert.equal(claudeCalls, 0); // review-first 抛，无改方
});

test('fix：commit 失败（worktree 可能脏）→ 抛停泊，且绝不带脏树跑 CI', async () => {
  const id = await mk();
  commitResult = { ok: false, committed: false, output: 'commit boom' };
  const s = (await sessions.get(id))!;
  await assert.rejects(() => runGateCLoop(s), /落提交失败/);
  assert.equal(commitCalls, 1);
  assert.equal(ciCalls, 0); // unimplemented review 未跑 CI；fix 在 commit 处即抛，绝不带脏树过 CI
});

test('fix：提交后 worktree 仍非 clean → 抛停泊（CI 须验 HEAD，不验脏树）', async () => {
  const id = await mk();
  cleanQueue = [false]; // commit 后 worktree 仍脏
  const s = (await sessions.get(id))!;
  await assert.rejects(() => runGateCLoop(s), /CI 须验 HEAD/);
  assert.equal(commitCalls, 1);
  assert.equal(ciCalls, 0);
});

test('claude 改方调用失败（瞬断）→ paused、不推进、不 commit（不把失败误计为多轮未消解）', async () => {
  const id = await mk();
  claudeOkQueue = [false]; // 改方 claude 瞬断
  const out = await runGateCLoop((await sessions.get(id))!);
  assert.equal(out.paused, true);
  assert.equal(commitCalls, 0); // res.ok=false → 绝不落提交
  assert.equal(claudeCalls, 1);
});

test('claude 升级 needs_human → needsHuman 出口（实现已落、等 M 拍板）', async () => {
  const id = await mk();
  claudeFix = JSON.stringify({ summary: '实现了但有取舍要拍板', needs_human: [{ id: 'H1', question: '退到余额还是原路退款？', options: [], context: '', severity: 'high' }] });
  const out = await runGateCLoop((await sessions.get(id))!);
  assert.ok(out.needsHuman && out.needsHuman.length === 1);
  assert.equal(commitCalls, 1); // 这轮实现已落提交，升级的是决策不是阻断
});

test('REVISION：负责人答复 → fix-first 无条件落实（带回上一轮升级问 + 答复进 prompt）→ 成功后清 pending + 留痕', async () => {
  const id = await mk({
    gate_c_pending_input: '走原路退款，并加幂等键防重复退款',
    // 上一轮 claude 升级、待拍板的点：peekHumanAnswer 须把它拼进上下文，让 claude 知道答的是哪问。
    gate_c_human_asks: JSON.stringify([{ id: 'H1', question: '退款方式：退余额 or 走原路？', options: [], context: '', severity: 'high' }]),
  });
  const out = await runGateCLoop((await sessions.get(id))!);
  assert.match(lastClaudePrompt, /退款方式：退余额 or 走原路/, '须带回上一轮升级问做上下文（否则答复脱离问题）');
  assert.match(lastClaudePrompt, /走原路退款/, '负责人答复必须喂进 fixer prompt（否则决定丢了）');
  const s = (await sessions.get(id))!;
  assert.equal(s.gate_c_pending_input, null); // 成功落盘才消费答复
  assert.equal(s.gate_c_human_asks, null); // 答复消费时一并清掉旧升级问
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gatec_human_answer_consumed'));
  assert.equal(out.resolved, true); // fix-first 后续审 CI 绿 → LGTM
});

test('改方坏 JSON → parseFixResult 返回 null 触发引擎自愈（resume 回喂重出）→ 恢复，绝不静默放行旧稿', async () => {
  const id = await mk();
  // 首个改方输出坏 JSON（解析失败），重出后给合法 JSON。parseFixResult 须返回 null 让引擎走 parse-repair，而非吞掉静默放行。
  claudeTextQueue = ['完全不是 JSON 的自然语言回答', JSON.stringify({ summary: '重出：实现完成', needs_human: [] })];
  // 第二次（repair 重出）只是重出 JSON、未改文件 → 建模为 no-op 提交（committed:false）。driver 须容忍：不抛、不停。
  commitQueue = [{ ok: true, committed: true, output: 'committed' }, { ok: true, committed: false, output: '无改动（repair 重出未改文件）' }];
  const out = await runGateCLoop((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(out.paused, true); // 自愈成功 → 正常推进（每-tick=1 → 暂停；不抛、不停泊）
  assert.equal(lastPersisted!.last_summary, '重出：实现完成'); // 落的是重出后的合法稿
  // 收紧（Codex SF3 + 二审 Nit1）：repair 重出不得污染轮次/计费；no-op 提交不得让 driver 抛/停。
  assert.equal(claudeCalls, 2); // 恰：坏 JSON 一次 + resume 重出一次（不多吞、不少修）
  assert.equal(s.gate_c_round, 1); // 自愈在「同一轮」内完成——绝不把 repair 误计成额外 round
  assert.equal(commitCalls, 2); // driver 每次 claude 成功都试落提交；第二次返回 committed:false（no-op）driver 照常放行
  assert.ok(Math.abs((s.gate_c_cost_usd ?? 0) - 0.02) < 1e-9, '两次 claude 调用都计费（repair 也付费），恰 0.02'); // 防计费漏/重
});

test('到硬上限仍不绿 → stalled + 残留落 gate_c_residual（交 M 裁决，绝不静默放行）', async () => {
  const id = await mk();
  hasCommits = true;
  ciOkDefault = false; // 每轮 CI 都红
  let out = await runGateCLoop((await sessions.get(id))!);
  for (let i = 0; i < 4 && !out.stalled; i++) out = await runGateCLoop((await sessions.get(id))!); // max_rounds=4，per-tick=1 → 第 4 轮触顶
  assert.equal(out.stalled, true);
  const residual = (await sessions.get(id))!.gate_c_residual;
  assert.ok(residual, '到上限须落残留交人工裁决');
  const parsed = JSON.parse(residual!) as { used: string; findings: unknown[] };
  assert.equal(parsed.used, 'ci'); // reviewer 是确定性 CI
  assert.ok(parsed.findings.length >= 1); // 残留意见（CI 失败摘要）非空
});
