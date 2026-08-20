// 集成：worker 编排（step 推进/停泊、tick 孤儿自愈）。mock 掉闸的实际 LLM 工作与通知。
process.env.FORGE_DB = ':memory:';
// 独立 tick 锁路径（每进程唯一）：tick.lock 是 STATE_DIR 下磁盘文件、不随 :memory: 隔离，
// 并行测试进程共享会互相误判「已有 tick 在跑」→ flaky。本文件是唯一调 worker.tick() 者，隔离它即可。
process.env.FORGE_LOCK = `${tmpdir()}/forge-tick-${process.pid}.lock`;
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const notifyCalls: string[] = [];
let syncCardCalls = 0; // Bug A 回归：进运行态须刷群卡（让团队看到「评审中」而非滞后的「排队」）
mock.module('../src/notify.ts', { namedExports: { notify: async (kind: string) => { notifyCalls.push(kind); }, syncGroupCard: async () => { syncCardCalls++; } } });

// 闸A：模拟成功（写入 routing），可切换为抛错；outcome 决定 afterGateA 的转移分支。
let gateAThrows = false;
let gateAErrorMsg = '闸A 解析失败'; // 可切换为瞬时错（如 'claude 超时'）测自动重试分类
let gateAOutcome = { round: 1, openQuestions: 2, resolved: false, stalled: false };
const sessionsRef: { mod?: typeof import('../src/store/sessions.ts') } = {};
mock.module('../src/gates/gateA.ts', {
  namedExports: {
    runGateA: async (s: { id: string }) => {
      if (gateAThrows) throw new Error(gateAErrorMsg);
      sessionsRef.mod!.patch(s.id, { routing: JSON.stringify({ reviewer: 'M', toLead: true, reasons: ['x'], confidence: 0.5 }), gate_a_round: 1 });
      return { ...gateAOutcome, round: 1 };
    },
    runGateARevision: async (s: { id: string; gate_a_round?: number | null }) => {
      if (gateAThrows) throw new Error('闸A 复评失败');
      sessionsRef.mod!.patch(s.id, { gate_a_round: (s.gate_a_round ?? 1) + 1, gate_a_pending_input: null });
      return gateAOutcome;
    },
  },
});

// 闸B 初稿：成功(写 draft 路径) / 抛错；finalizeGateBDoc no-op。
let gateBThrows = false;
mock.module('../src/gates/gateB.ts', {
  namedExports: {
    runGateB: async (s: { id: string }) => {
      if (gateBThrows) throw new Error('闸B 初稿失败');
      sessionsRef.mod!.patch(s.id, { gate_b_draft_path: '/tmp/gate-b.json', gate_b_round: 0 });
      return { summary: 'x', key_decisions: {}, tech_design_markdown: '', multi_repo: false, epic_doc_type: 'feat', issue_specs: [{ repo: 'A', title: 't', type: 'feat', prio: 'P2' }], confidence: 0.6 };
    },
    finalizeGateBDoc: () => {},
  },
});

// 闸B 对抗循环：outcome 决定 afterGateB 的转移分支；可切换为抛错。
let gateBLoopThrows = false;
type RFOutcome = { round: number; verdict: string; resolved: boolean; needsHuman: unknown[] | null; stalled: boolean; paused: boolean; unresolvedFindings: unknown[] };
let gateBOutcome: RFOutcome = { round: 1, verdict: 'clean', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
mock.module('../src/gates/gateBLoop.ts', {
  namedExports: {
    runGateBLoop: async (_s: unknown) => {
      if (gateBLoopThrows) throw new Error('对抗失败');
      return gateBOutcome;
    },
  },
});

// 闸A 对抗循环：outcome 决定 afterGateAAdversarial 的转移分支；可切换为抛错。
let gateALoopThrows = false;
let gateALoopErrorMsg = '闸A 对抗失败';
let gateALoopOutcome: RFOutcome = { round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
mock.module('../src/gates/gateALoop.ts', {
  namedExports: {
    runGateALoop: async (_s: unknown) => {
      if (gateALoopThrows) throw new Error(gateALoopErrorMsg);
      return gateALoopOutcome;
    },
    // afterGateAAdversarial resolved 分支重读 gate-a.json 查 codex 是否补出 PM 未答问题——读 writeGateA 写的真实文件。
    readGateAEnvelope: (s: { gate_a_output_path?: string | null }) =>
      s.gate_a_output_path
        ? JSON.parse(readFileSync(s.gate_a_output_path, 'utf8'))
        : { summary: 's', open_questions: [], risks: [] },
  },
});

// 闸C：setup no-op；实现⇄CI 循环 outcome 决定 afterGateC 分支；可切换抛错。worker 是唯一 importer（mock 安全）。
let gateCLoopThrows = false;
let gateCOutcome: RFOutcome = { round: 1, verdict: 'LGTM', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [] };
mock.module('../src/gates/gateC.ts', { namedExports: { runGateCSetup: async () => {}, activateLeg: () => {}, activeLeg: () => null } });
mock.module('../src/gates/gateCLoop.ts', {
  namedExports: {
    runGateCLoop: async (_s: unknown) => {
      if (gateCLoopThrows) throw new Error('闸C 实现失败');
      return gateCOutcome;
    },
  },
});

// 闸D：开 PR no-op（可切抛错）；PR 对抗循环 outcome 决定 afterGateD 分支。
let openPrThrows = false;
let gateDLoopThrows = false;
let gateDOutcome: RFOutcome = { round: 1, verdict: 'LGTM', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [] };
mock.module('../src/gates/gateD.ts', {
  namedExports: { openReviewPr: async (s: { id: string }) => { if (openPrThrows) throw new Error('开 PR 失败：gh auth'); sessionsRef.mod!.patch(s.id, { pr_url: 'https://x/pull/1', pr_number: 1 }); } },
});
mock.module('../src/gates/gateDLoop.ts', {
  namedExports: {
    runGateDLoop: async (_s: unknown) => {
      if (gateDLoopThrows) throw new Error('闸D PR 复审失败');
      return gateDOutcome;
    },
    MAX_CI_FIX_ATTEMPTS: 2, // worker.lockMaxHoldSec 用其估单 tick 最长；mock 须同真值导出，否则 import 报缺
  },
});
// 闸D 测试补强：成功 no-op（worker 据此置 AWAITING_HUMAN_MERGE + needs_merge）；可切抛错测停泊。
let gateDHardenThrows = false;
mock.module('../src/gates/gateDHarden.ts', {
  namedExports: {
    runGateDHarden: async (s: { id: string }) => {
      if (gateDHardenThrows) throw new Error('闸D 补强失败：CI 仍红');
      sessionsRef.mod!.patch(s.id, { gate_d_harden_round: 1, merge_readiness_path: '/tmp/merge-readiness.md' });
    },
  },
});

// 自动指派负载探针走真 gh——mock 成空池（afterGateB clean 进 AWAITING_GO 会算推荐）。
mock.module('../src/util/load.ts', { namedExports: { probeLoad: async () => [] } });
// worktree 助手：worker 用 worktreeHeadSha pin 闸D 绿态；actions(ackMerged) 用 removeWorktree/deleteBranch。
// headSha 可切 null 测「LGTM 但取不到绿态 HEAD → 停泊」。
let headSha: string | null = 'GREENSHA';
mock.module('../src/util/worktree.ts', {
  namedExports: {
    worktreeHeadSha: () => headSha,
    removeWorktree: async () => ({ ok: true, output: '' }),
    deleteBranch: () => {},
    listWorktrees: () => [], // 孤儿清扫：本测试无 worktree → 列空，sweep no-op
    planWorktreeSweep: () => [],
  },
});

const sessions = await import('../src/store/sessions.ts');
sessionsRef.mod = sessions;
const worker = await import('../src/orchestrator/worker.ts');
// bounded claim（深水⑥ Blocker 修复）后，tick 每轮只 FIFO 领 max_parallel(=2) 条最旧到期 job。前序测试遗留的
// session 会被 reclaim/reconcile 复活成 free poller、挤掉本测试目标(keepId)的名额 → 目标领不到、不被 step
//（生产里 FIFO 偏向最旧、retry 的旧 session 反而优先，无此问题——纯测试串库 artefact）。清场：把除 keepId 外所有
// 现存 session 直接 patch 成终态 SHIPPED（直写 state、绕状态机——纯测试用），让本 tick 的 reclaim/reconcile/claim
// 都无前序遗留可复活/认领，只剩 keepId 能被推进。
async function parkLeftoverReady(keepId: string): Promise<void> {
  for (const s of await sessions.listAll()) {
    if (s.id !== keepId) await sessions.patch(s.id, { state: 'SHIPPED' });
  }
}

async function mk(id: string, state: string) {
  await sessions.create({ id, slug: id, title: 'T', branch: 'dev' });
  const toGateB = ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED'];
  const toGateDLoop = [...toGateB, 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE', 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'AWAITING_GATE_D', 'GATE_D_REQUESTED', 'GATE_D_LOOP'];
  const path: Record<string, string[]> = {
    INTAKE: [],
    GATE_B_REQUESTED: toGateB,
    ADVERSARIAL_LOOP: [...toGateB, 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP'],
    GATE_B_REVISION_REQUESTED: [...toGateB, 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GATE_B_INPUT', 'GATE_B_REVISION_REQUESTED'],
    GATE_A_RUNNING: ['GATE_A_RUNNING'],
    GATE_A_ADVERSARIAL: ['GATE_A_RUNNING', 'GATE_A_ADVERSARIAL'],
    GATE_A_REVISION_REQUESTED: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'GATE_A_REVISION_REQUESTED'],
    AWAITING_GATE_D: toGateDLoop.slice(0, -2), // 到 AWAITING_GATE_D（去掉末尾 GATE_D_REQUESTED/LOOP）
    GATE_D_REQUESTED: toGateDLoop.slice(0, -1),
    GATE_D_LOOP: toGateDLoop,
    GATE_D_HARDENING: [...toGateDLoop, 'GATE_D_HARDENING'],
    GATE_D_REVISION_REQUESTED: [...toGateDLoop, 'AWAITING_GATE_D_INPUT', 'GATE_D_REVISION_REQUESTED'],
  };
  for (const s of path[state] ?? []) await sessions.transition(id, s as never);
  return id;
}

// afterGateAAdversarial 的 resolved 分支会重读 gate-a.json（查 codex 是否补出 PM 未答的 open_questions）——
// 给 GATE_A_ADVERSARIAL 的 resolved 用例铺一份真实 envelope。形状同 gateALoop.test 的 BASE_ENV。
const GATE_A_ENV = {
  summary: 's', repos_touched: ['C'], size: 'M', size_reason: '', open_questions: [], risks: [],
  confidence: 0.5, needs_lead: false, prd_score: 0, prd_score_dims: { clarity: 0, completeness: 0, feasibility: 0, testability: 0 }, prd_score_reason: '',
};
async function writeGateA(id: string, openQuestions: unknown[] = []) {
  const p = join(mkdtempSync(join(tmpdir(), 'forge-wk-gatea-')), 'gate-a.json');
  writeFileSync(p, JSON.stringify({ ...GATE_A_ENV, open_questions: openQuestions }));
  await sessions.patch(id, { gate_a_output_path: p });
}

test('step(INTAKE)：闸A 成功(仍有开放问题) → AWAITING_PM_CONFIRM + needs_confirm 通知', async () => {
  notifyCalls.length = 0;
  gateAThrows = false;
  gateAOutcome = { round: 1, openQuestions: 2, resolved: false, stalled: false };
  const id = await mk('w1', 'INTAKE');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_PM_CONFIRM');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_a_done'));
  assert.ok(notifyCalls.includes('needs_confirm'));
});

test('step(INTAKE)：进 GATE_A_RUNNING 时刷新群卡（Bug A：团队看到「评审中」而非滞后的「排队」）', async () => {
  syncCardCalls = 0;
  gateAThrows = false;
  gateAOutcome = { round: 1, openQuestions: 2, resolved: false, stalled: false };
  const id = await mk('w1-card', 'INTAKE');
  await worker.step((await sessions.get(id))!);
  assert.ok(syncCardCalls >= 1, '进运行态应至少刷一次群卡');
});

test('step(INTAKE)：闸A 无开放问题 → 自动 CONFIRMED + needs_gateb 通知', async () => {
  notifyCalls.length = 0;
  gateAThrows = false;
  gateAOutcome = { round: 1, openQuestions: 0, resolved: true, stalled: false };
  const id = await mk('w1b', 'INTAKE');
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_ADVERSARIAL'); // 无开放问题 → 先进 codex 对抗，不再直接确认
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_a_resolved'));
  assert.ok(!notifyCalls.includes('needs_gateb')); // 确认推迟到 codex 通过后
});

test('step(GATE_A_REVISION_REQUESTED)：复评仍有问题 → 回 AWAITING_PM_CONFIRM（下一轮）', async () => {
  notifyCalls.length = 0;
  gateAThrows = false;
  gateAOutcome = { round: 2, openQuestions: 1, resolved: false, stalled: false };
  const id = await mk('wr1', 'GATE_A_REVISION_REQUESTED');
  await sessions.patch(id, { gate_a_pending_input: 'PM 答复' });
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_PM_CONFIRM');
  assert.ok(notifyCalls.includes('needs_confirm'));
});

test('step(GATE_A_REVISION_REQUESTED)：复评无剩余 → 进 GATE_A_ADVERSARIAL（codex 对抗）', async () => {
  notifyCalls.length = 0;
  gateAThrows = false;
  gateAOutcome = { round: 3, openQuestions: 0, resolved: true, stalled: false };
  const id = await mk('wr2', 'GATE_A_REVISION_REQUESTED');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_A_ADVERSARIAL');
  assert.ok(!notifyCalls.includes('needs_gateb'));
});

test('step(GATE_A_ADVERSARIAL)：codex LGTM → CONFIRMED + needs_gateb', async () => {
  notifyCalls.length = 0;
  gateALoopThrows = false;
  gateALoopOutcome = { round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  const id = await mk('wa1', 'GATE_A_ADVERSARIAL');
  await writeGateA(id, []); // 对抗未补出新问题 → 自动确认
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'CONFIRMED');
  assert.equal(s.confirmed_by, 'AI');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gatea_adv_resolved'));
  assert.ok(notifyCalls.includes('needs_gateb'));
});

test('step(GATE_A_ADVERSARIAL)：codex 对抗补出 PM 未答的 open_questions → 弹回 AWAITING_PM_CONFIRM（不自动确认）', async () => {
  notifyCalls.length = 0;
  gateALoopThrows = false;
  gateALoopOutcome = { round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  const id = await mk('wa5', 'GATE_A_ADVERSARIAL');
  await sessions.patch(id, { gate_a_adv_round: 1, gate_a_reviewer_session: 'codex-x', gate_a_fixer_session: 'claude-y' });
  await writeGateA(id, [{ q: '退款去哪？', suggestion: '余额', severity: 'high', options: [] }]); // 对抗补出 1 条漏问
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_PM_CONFIRM'); // 不进闸B，弹回 PM
  assert.equal(s.confirmed_by, null); // 没自动确认
  assert.ok(notifyCalls.includes('needs_confirm'));
  assert.equal(notifyCalls.includes('needs_gateb'), false);
  assert.equal(s.gate_a_adv_round, null); // 对抗簿记重置（弹回后再起一轮 fresh 对抗）
  assert.equal(s.gate_a_reviewer_session, null);
  assert.equal(s.gate_a_fixer_session, null);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gatea_adv_reopened'));
});

test('生产链路：对抗补漏问 → PM 答复 → 复评清空 → fresh 对抗通过后才通知闸B', async () => {
  notifyCalls.length = 0;
  gateAThrows = false; gateALoopThrows = false;
  const actions = await import('../src/actions.ts');
  const id = await mk('prod-gatea-reopen', 'GATE_A_ADVERSARIAL');
  await sessions.patch(id, { gate_a_adv_round: 1, gate_a_reviewer_session: 'codex-old', gate_a_fixer_session: 'claude-old' });

  gateALoopOutcome = { round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  await writeGateA(id, [{
    q: '退款退到哪里？',
    suggestion: '建议退到余额',
    severity: 'high',
    options: [{ label: '退到余额', recommended: true, impact: '用户可继续消费，避免原路失败' }],
  }]);
  await worker.step((await sessions.get(id))!);

  let s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_PM_CONFIRM');
  assert.equal(s.confirmed_by, null);
  assert.equal(s.gate_a_adv_round, null);
  assert.equal(s.gate_a_reviewer_session, null);
  assert.equal(s.gate_a_fixer_session, null);
  assert.ok(notifyCalls.includes('needs_confirm'));
  assert.equal(notifyCalls.includes('needs_gateb'), false);

  const reply = await actions.submitPmAnswers(id, 'PM', 'H1（退款退到哪里？）：退到余额');
  assert.equal(reply.ok, true);
  assert.equal((await sessions.get(id))!.state, 'GATE_A_REVISION_REQUESTED');

  notifyCalls.length = 0;
  gateAOutcome = { round: 2, openQuestions: 0, resolved: true, stalled: false };
  await writeGateA(id, []); // 真实复评会把 PM 已答问题消掉；这里用文件体现产物变化。
  await worker.step((await sessions.get(id))!);
  s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_ADVERSARIAL');
  assert.equal(s.gate_a_adv_round, 0); // fresh 对抗哨兵重新落下，而非复用旧 codex/claude 会话
  assert.equal(s.gate_a_reviewer_session, null);
  assert.equal(s.gate_a_fixer_session, null);
  assert.equal(notifyCalls.includes('needs_gateb'), false);

  await worker.step((await sessions.get(id))!);
  s = (await sessions.get(id))!;
  assert.equal(s.state, 'CONFIRMED');
  assert.equal(s.confirmed_by, 'AI');
  assert.match(s.confirmed_notes ?? '', /退到余额/);
  assert.ok(notifyCalls.includes('needs_gateb'));
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gatea_adv_reopened'));
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gatea_adv_resolved'));
});

test('step(GATE_A_ADVERSARIAL)：到上限未消解 → GATE_A_STALLED + needs_arbitration', async () => {
  notifyCalls.length = 0;
  gateALoopThrows = false;
  gateALoopOutcome = { round: 3, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: true, paused: false, unresolvedFindings: [{ issue: 'x' }] };
  const id = await mk('wa2', 'GATE_A_ADVERSARIAL');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_A_STALLED');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gatea_adv_stalled'));
  assert.ok(notifyCalls.includes('needs_arbitration'));
});

test('step(GATE_A_ADVERSARIAL)：每-tick 上限暂停 → 留 GATE_A_ADVERSARIAL（下个 tick 续）', async () => {
  notifyCalls.length = 0;
  gateALoopThrows = false;
  gateALoopOutcome = { round: 2, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [] };
  const id = await mk('wa3', 'GATE_A_ADVERSARIAL');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_A_ADVERSARIAL');
  assert.ok(notifyCalls.length === 0); // 暂停不发通知
});

test('step(GATE_A_ADVERSARIAL)：对抗抛错 → 停泊 GATE_A_FAILED + failed', async () => {
  notifyCalls.length = 0;
  gateALoopThrows = true;
  gateALoopErrorMsg = '闸A 对抗失败';
  const id = await mk('wa4', 'GATE_A_ADVERSARIAL');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_A_FAILED');
  assert.ok(notifyCalls.includes('failed'));
  gateALoopThrows = false;
});

test('step(GATE_A_REVISION_REQUESTED)：到上限未消解 → GATE_A_STALLED + needs_arbitration', async () => {
  notifyCalls.length = 0;
  gateAThrows = false;
  gateAOutcome = { round: 6, openQuestions: 2, resolved: false, stalled: true };
  const id = await mk('wr3', 'GATE_A_REVISION_REQUESTED');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_A_STALLED');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_a_stalled'));
  assert.ok(notifyCalls.includes('needs_arbitration'));
});

test('step(GATE_A_REVISION_REQUESTED)：复评抛错 → 停泊 GATE_A_FAILED + failed', async () => {
  notifyCalls.length = 0;
  gateAThrows = true;
  const id = await mk('wr4', 'GATE_A_REVISION_REQUESTED');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_A_FAILED');
  assert.ok(notifyCalls.includes('failed'));
});

test('step(INTAKE)：闸A 抛错 → 停泊 GATE_A_FAILED + 记 error + failed 通知', async () => {
  notifyCalls.length = 0;
  gateAThrows = true;
  const id = await mk('w2', 'INTAKE');
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_FAILED');
  assert.match(s.error ?? '', /闸A 解析失败/);
  assert.ok(notifyCalls.includes('failed'));
});

// ── 闸B codex审⇄claude改 循环 ──
test('step(GATE_B_REQUESTED)：初稿 + 对抗 clean → AWAITING_GO + needs_go', async () => {
  notifyCalls.length = 0;
  gateBThrows = false; gateBLoopThrows = false;
  gateBOutcome = { round: 1, verdict: 'clean', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  const id = await mk('wb1', 'GATE_B_REQUESTED');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_b_done'));
  assert.ok(notifyCalls.includes('needs_go'));
});

test('step(GATE_B_REQUESTED)：改方升级 needs_human → AWAITING_GATE_B_INPUT + 存 asks + needs_gateb_input', async () => {
  notifyCalls.length = 0;
  gateBThrows = false; gateBLoopThrows = false;
  gateBOutcome = { round: 1, verdict: 'needs_revision', resolved: false, needsHuman: [{ id: 'H1', question: '退款去向？' }], stalled: false, paused: false, unresolvedFindings: [{ issue: 'x' }] };
  const id = await mk('wb2', 'GATE_B_REQUESTED');
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_GATE_B_INPUT');
  assert.match(s.gate_b_human_asks ?? '', /退款去向/);
  assert.ok(notifyCalls.includes('needs_gateb_input'));
});

test('step(GATE_B_REQUESTED)：到上限未消解 → GATE_B_STALLED + needs_gateb_arbitration', async () => {
  notifyCalls.length = 0;
  gateBThrows = false; gateBLoopThrows = false;
  gateBOutcome = { round: 3, verdict: 'needs_revision', resolved: false, needsHuman: null, stalled: true, paused: false, unresolvedFindings: [{ issue: 'a' }, { issue: 'b' }] };
  const id = await mk('wb3', 'GATE_B_REQUESTED');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_B_STALLED');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_b_stalled'));
  assert.ok(notifyCalls.includes('needs_gateb_arbitration'));
});

test('step(GATE_B_REQUESTED)：每-tick 上限 → 留 ADVERSARIAL_LOOP（不发通知）', async () => {
  notifyCalls.length = 0;
  gateBThrows = false; gateBLoopThrows = false;
  gateBOutcome = { round: 2, verdict: 'needs_revision', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [{ issue: 'x' }] };
  const id = await mk('wb4', 'GATE_B_REQUESTED');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'ADVERSARIAL_LOOP');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gateb_loop_paused'));
  assert.equal(notifyCalls.includes('needs_go'), false);
});

test('step(ADVERSARIAL_LOOP)：续跑 clean → AWAITING_GO', async () => {
  notifyCalls.length = 0;
  gateBThrows = false; gateBLoopThrows = false;
  gateBOutcome = { round: 3, verdict: 'clean', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  const id = await mk('wb5', 'ADVERSARIAL_LOOP');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO');
  assert.ok(notifyCalls.includes('needs_go'));
});

test('step(ADVERSARIAL_LOOP)：再修通过(resolved) → 清掉旧停泊残留（GO 卡不留陈旧条数）', async () => {
  notifyCalls.length = 0;
  gateBThrows = false; gateBLoopThrows = false;
  gateBOutcome = { round: 2, verdict: 'clean', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  const id = await mk('wb9', 'ADVERSARIAL_LOOP');
  await sessions.patch(id, { adversarial_residual: JSON.stringify({ round: 1, findings: [{ issue: 'old' }] }) });
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_GO');
  assert.equal(s.adversarial_residual, null); // resolved 清残留
});

test('step(GATE_B_REVISION_REQUESTED)：M 答复后续修 clean → AWAITING_GO', async () => {
  notifyCalls.length = 0;
  gateBThrows = false; gateBLoopThrows = false;
  gateBOutcome = { round: 2, verdict: 'clean', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  const id = await mk('wb6', 'GATE_B_REVISION_REQUESTED');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO');
  assert.ok(notifyCalls.includes('needs_go'));
});

test('step(GATE_B_REQUESTED)：初稿抛错 → GATE_B_FAILED + failed', async () => {
  notifyCalls.length = 0;
  gateBThrows = true; gateBLoopThrows = false;
  const id = await mk('wb7', 'GATE_B_REQUESTED');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_B_FAILED');
  assert.ok(notifyCalls.includes('failed'));
});

test('step(ADVERSARIAL_LOOP)：对抗抛错 → GATE_B_FAILED + failed', async () => {
  notifyCalls.length = 0;
  gateBThrows = false; gateBLoopThrows = true;
  const id = await mk('wb8', 'ADVERSARIAL_LOOP');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_B_FAILED');
  assert.ok(notifyCalls.includes('failed'));
});

test('step(GATE_B_REVISION_REQUESTED)：续修失败停泊时保留负责人答复和旧残留，便于 retry 重新落实', async () => {
  notifyCalls.length = 0;
  gateBThrows = false; gateBLoopThrows = true;
  const id = await mk('wb10', 'GATE_B_REVISION_REQUESTED');
  await sessions.patch(id, {
    gate_b_pending_input: 'M 决定：余额退款，补幂等验收',
    adversarial_residual: JSON.stringify({ round: 3, findings: [{ issue: '旧的未决复审意见' }] }),
  });
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_B_FAILED');
  assert.equal(s.gate_b_pending_input, 'M 决定：余额退款，补幂等验收');
  assert.match(s.adversarial_residual ?? '', /旧的未决复审意见/);
  assert.ok(notifyCalls.includes('failed'));
});

// ── 闸D PR 对抗 review（开 PR + codex审diff⇄claude修）──
test('step(GATE_D_REQUESTED)：开 PR ok → GATE_D_LOOP（循环本 tick 暂停留 LOOP）+ 落 pr_url', async () => {
  benignMocks();
  openPrThrows = false;
  gateDOutcome = { round: 1, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [] };
  const id = await mk('wd1', 'GATE_D_REQUESTED');
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_D_LOOP');
  assert.equal(s.pr_url, 'https://x/pull/1'); // 开 PR 落库
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gated_loop_paused'));
});

test('step(GATE_D_LOOP)：codex LGTM → GATE_D_HARDENING + pin 绿态 sha（被 LGTM 的提交即补强基线）', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateDOutcome = { round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  const id = await mk('wd2', 'GATE_D_LOOP');
  await sessions.patch(id, { worktree_path: '/wt/x' }); // 有隔离树 → 能取 HEAD pin 绿态
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_D_HARDENING');
  assert.equal(s.gate_d_green_sha, 'GREENSHA'); // 关键：pin 的是当前 worktree HEAD（被 codex LGTM 的提交）
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_d_done'));
});

test('step(GATE_D_LOOP)：codex LGTM 但取不到绿态 HEAD → 停泊 GATE_D_FAILED（绝不进补强，钉在 pin 点）', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateDOutcome = { round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  headSha = null; // worktreeHeadSha 取不到
  const id = await mk('wd2b', 'GATE_D_LOOP');
  await sessions.patch(id, { worktree_path: '/wt/x' });
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_D_FAILED'); // 当场停泊，不进 HARDENING
  assert.equal((await sessions.get(id))!.gate_d_green_sha, null);
});

test('step(GATE_D_LOOP)：改方升级 needs_human → AWAITING_GATE_D_INPUT + needs_gated_input', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateDOutcome = { round: 1, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: [{ id: 'H1', question: '改契约还是改实现？' }], stalled: false, paused: false, unresolvedFindings: [{ issue: 'x' }] };
  const id = await mk('wd3', 'GATE_D_LOOP');
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_GATE_D_INPUT');
  assert.match(s.gate_d_human_asks ?? '', /改契约还是改实现/);
  assert.ok(notifyCalls.includes('needs_gated_input'));
});

test('step(GATE_D_LOOP)：到上限未决 → GATE_D_STALLED + needs_gated_arbitration', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateDOutcome = { round: 3, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: true, paused: false, unresolvedFindings: [{ issue: 'a' }] };
  const id = await mk('wd4', 'GATE_D_LOOP');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_D_STALLED');
  assert.ok(notifyCalls.includes('needs_gated_arbitration'));
});

test('step(GATE_D_REQUESTED)：开 PR 抛错 → GATE_D_FAILED + failed', async () => {
  notifyCalls.length = 0;
  benignMocks();
  openPrThrows = true;
  const id = await mk('wd5', 'GATE_D_REQUESTED');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_D_FAILED');
  assert.ok(notifyCalls.includes('failed'));
});

test('step(GATE_D_HARDENING)：补强成功 → AWAITING_HUMAN_MERGE + needs_merge（永不自动合并）', async () => {
  notifyCalls.length = 0;
  benignMocks();
  const id = await mk('wdh1', 'GATE_D_HARDENING');
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_HUMAN_MERGE'); // 合并就绪，停在人工合并（绝不自动 SHIPPED）
  assert.equal(s.merge_readiness_path, '/tmp/merge-readiness.md');
  assert.ok(notifyCalls.includes('needs_merge'));
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_d_hardened'));
  // 交付文档自动提交默认关（runtime.yaml 无 delivery_doc_commit）→ 真 maybeCommitDeliveryDocs 优雅 no-op、不崩、无事件。
  assert.ok(!(await sessions.events(id)).some((e) => e.kind === 'delivery_docs_committed'));
});

test('step(GATE_D_HARDENING)：补强抛错 → GATE_D_FAILED + failed', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateDHardenThrows = true;
  const id = await mk('wdh2', 'GATE_D_HARDENING');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_D_FAILED');
  assert.ok(notifyCalls.includes('failed'));
});

test('step(GATE_D_REVISION_REQUESTED)：回 LOOP 前清陈旧补强标记（防失败后 planRetry 误回 HARDENING）', async () => {
  benignMocks();
  gateDOutcome = { round: 2, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [] };
  const id = await mk('wdrev', 'GATE_D_REVISION_REQUESTED');
  // 模拟「合并就绪退回续修」遗留的陈旧补强标记。
  await sessions.patch(id, { gate_d_harden_round: 1, merge_readiness_path: '/x.md', gate_d_green_sha: 'G', gate_d_harden_verified_sha: 'V' });
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.gate_d_harden_round, null);
  assert.equal(s.merge_readiness_path, null);
  assert.equal(s.gate_d_green_sha, null);
  assert.equal(s.gate_d_harden_verified_sha, null);
});

test('tick：GATE_D_FAILED 瞬时失败退避到点 → reconcile 自动重试回 GATE_D_LOOP（有 pr_url）', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateDOutcome = { round: 2, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [] };
  const id = await mk('wd6', 'GATE_D_LOOP');
  // 钉成已开 PR 的瞬时失败 + 退避到点。
  await sessions.transition(id, 'GATE_D_FAILED', { pr_url: 'https://x/pull/9', retry_count: 1, next_retry_at: Date.now() - 1 });
  await worker.tick();
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_D_LOOP'); // 漏纳入 reconcile 时会永远卡在 GATE_D_FAILED
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'auto_retry' && (e.detail ?? '').includes('GATE_D_LOOP')));
});

test('tick：GATE_D_FAILED 带回滚毒丸退避到点 → reconcile 回 LOOP 后 step 再失败 → 回 GATE_D_FAILED，毒丸全程存活（Codex 四审 SF）', async () => {
  // worker 级毒丸链路：reconcile(planRetry 不清毒丸) → step 调 runGateDLoop（此处 throw 代表真实 recoverPendingRollback
  // 复位再失败而 reject）→ parkFailure 回 GATE_D_FAILED。断言整条 worker round-trip 都没把毒丸清掉——
  // 否则下次进 loop 就守不住，红/脏 HEAD 会进 review-first。「不进 review」本身在 gateDLoop.test.ts 用真 recover 已证。
  notifyCalls.length = 0;
  benignMocks();
  gateDLoopThrows = true; // 代表 runGateDLoop 因 recover 复位再失败而抛
  const id = await mk('wd7', 'GATE_D_LOOP');
  await sessions.transition(id, 'GATE_D_FAILED', { pr_url: 'https://x/pull/9', gate_d_rollback_to: 'GREENSHA', retry_count: 1, next_retry_at: Date.now() - 1 });
  await parkLeftoverReady(id); // 隔离前序遗留 ready，确保本测试目标进 bounded claim 名额
  await worker.tick();
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_D_FAILED'); // reconcile→LOOP→step 再抛→回停泊
  assert.equal(s.gate_d_rollback_to, 'GREENSHA'); // 毒丸全程存活（planRetry 不清、parkFailure 不清）→ 下次进 loop 仍守门
});

// tick() 处理全库 ready session，下面三个 tick 测试统一把 mock 置为良性，避免前面遗留的 poller 态被异常推进污染。
function benignMocks() {
  gateAThrows = false; gateBThrows = false; gateBLoopThrows = false;
  gateALoopThrows = false; gateALoopErrorMsg = '闸A 对抗失败';
  gateCLoopThrows = false;
  openPrThrows = false; gateDLoopThrows = false; gateDHardenThrows = false;
  headSha = 'GREENSHA';
  gateAErrorMsg = '闸A 解析失败';
  gateALoopOutcome = { round: 2, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [] };
  gateBOutcome = { round: 1, verdict: 'clean', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
}

test('tick：孤儿态(GATE_A_RUNNING·首轮)自愈 → 回 INTAKE 重跑，最终离开瞬态', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateAOutcome = { round: 1, openQuestions: 2, resolved: false, stalled: false };
  const id = await mk('w4', 'GATE_A_RUNNING'); // 模拟上个 tick 中途死掉留下的孤儿（首轮：无 pending_input）
  await worker.tick();
  const s = (await sessions.get(id))!;
  assert.notEqual(s.state, 'GATE_A_RUNNING'); // 不再卡在瞬态
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'recover' && (e.detail ?? '').includes('INTAKE')));
  assert.ok(notifyCalls.includes('recovered'));
});

test('tick：孤儿态(GATE_A_RUNNING·复评)自愈 → 回 GATE_A_REVISION_REQUESTED 不丢轮次', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateAOutcome = { round: 2, openQuestions: 1, resolved: false, stalled: false };
  const id = await mk('w5', 'GATE_A_RUNNING');
  await sessions.patch(id, { gate_a_pending_input: 'PM 这轮答复', gate_a_round: 1 }); // 复评中途死的标志
  await worker.tick();
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'recover' && (e.detail ?? '').includes('GATE_A_REVISION_REQUESTED')));
  assert.notEqual((await sessions.get(id))!.state, 'GATE_A_RUNNING');
});

test('tick：孤儿态(GATE_B_RUNNING·初稿中途死)自愈 → 回 GATE_B_REQUESTED', async () => {
  notifyCalls.length = 0;
  benignMocks();
  const id = await mk('w6', 'GATE_B_REQUESTED');
  await sessions.transition(id, 'GATE_B_RUNNING'); // 初稿瞬态孤儿
  await worker.tick();
  // tick 会先 reclaim（→GATE_B_REQUESTED）再正常推进；只断言离开了 GATE_B_RUNNING 瞬态 + 有 recover 事件。
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'recover' && (e.detail ?? '').includes('GATE_B_REQUESTED')));
  assert.notEqual((await sessions.get(id))!.state, 'GATE_B_RUNNING');
});

// ── 节点失败重试基础设施（P0-A/B）──
test('step(INTAKE)：瞬时失败(超时) → 排程退避自动重试（记 retry_count/next_retry_at，不发 failed）', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateAThrows = true; gateAErrorMsg = '闸A claude 失败：claude 超时';
  const id = await mk('rt1', 'INTAKE');
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_FAILED');
  assert.equal(s.retry_count, 1);
  assert.ok((s.next_retry_at ?? 0) > Date.now());
  assert.equal(s.dead_letter, null); // 未死信
  assert.equal(notifyCalls.includes('failed'), false); // 瞬时不发通知
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'retry_scheduled'));
});

test('tick：退避到点 → reconcile 自动重试，成功推进后清重试簿记', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateAOutcome = { round: 1, openQuestions: 2, resolved: false, stalled: false };
  gateAThrows = true; gateAErrorMsg = 'claude 超时'; // 先制造一次瞬时失败排程
  const id = await mk('rt2', 'INTAKE');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_A_FAILED');
  assert.equal((await sessions.get(id))!.retry_count, 1);
  // 退避到点 + 下次成功 → tick 自动重试
  await sessions.patch(id, { next_retry_at: Date.now() - 1 });
  benignMocks();
  gateAOutcome = { round: 1, openQuestions: 2, resolved: false, stalled: false };
  await parkLeftoverReady(id); // 隔离前序遗留 ready，确保本测试目标进 bounded claim 名额
  await worker.tick();
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_PM_CONFIRM'); // 重试成功推进
  assert.equal(s.retry_count, null); // clearRetry 清簿记
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'auto_retry'));
});

test('生产链路：闸A对抗首轮瞬时失败 → 退避到点后原地续对抗，不退回INTAKE重问PM', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateAOutcome = { round: 1, openQuestions: 0, resolved: true, stalled: false };
  const id = await mk('rt-gatea-adv-first-fail', 'INTAKE');
  await worker.step((await sessions.get(id))!);
  let s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_ADVERSARIAL');
  assert.equal(s.gate_a_adv_round, 0);

  gateALoopThrows = true;
  gateALoopErrorMsg = 'codex 超时';
  await worker.step((await sessions.get(id))!);
  s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_FAILED');
  assert.equal(s.gate_a_adv_round, 0);
  assert.equal(s.retry_count, 1);
  assert.ok((s.next_retry_at ?? 0) > Date.now());
  assert.equal(notifyCalls.includes('failed'), false);

  await sessions.patch(id, { next_retry_at: Date.now() - 1 });
  gateALoopThrows = false;
  gateALoopOutcome = { round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  await writeGateA(id, []);
  await parkLeftoverReady(id); // 隔离前序遗留 ready，确保本测试目标进 bounded claim 名额
  await worker.tick();
  s = (await sessions.get(id))!;
  assert.equal(s.state, 'CONFIRMED');
  assert.equal(s.confirmed_by, 'AI');
  assert.equal(s.retry_count, null);
  assert.equal(s.next_retry_at, null);
  assert.equal((await sessions.events(id)).some((e) => e.kind === 'auto_retry' && (e.detail ?? '').includes('GATE_A_ADVERSARIAL')), true);
  assert.equal((await sessions.events(id)).some((e) => e.kind === 'transition' && (e.detail ?? '').includes('"to":"INTAKE"')), false);
  assert.ok(notifyCalls.includes('needs_gateb'));
  assert.equal(notifyCalls.includes('needs_confirm'), false);
});

test('step：瞬时失败重试耗尽（达上限）→ 转死信 + failed 通知', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateAThrows = true; gateAErrorMsg = 'claude 超时';
  const id = await mk('rt3', 'INTAKE');
  await sessions.patch(id, { retry_count: 3 }); // 已达 max_auto_retries(3)
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_FAILED');
  assert.equal(s.dead_letter, 1);
  assert.equal(s.next_retry_at, null);
  assert.ok(notifyCalls.includes('failed'));
});

test('tick：孤儿复位达上限 → 死信（毒丸保护），不再复活', async () => {
  notifyCalls.length = 0;
  benignMocks();
  const id = await mk('rt4', 'GATE_A_RUNNING');
  await sessions.patch(id, { reclaim_count: 3 }); // 已达 max_reclaims(3)
  await worker.tick();
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_FAILED'); // 没被复活回 INTAKE
  assert.equal(s.dead_letter, 1);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'dead_letter'));
  assert.equal(notifyCalls.includes('failed'), true);
});

test('tick：死信 session 不被 reconcile 自动重试', async () => {
  notifyCalls.length = 0;
  benignMocks();
  const id = await mk('rt5', 'INTAKE');
  // 直接把它钉成死信的 GATE_A_FAILED + 退避已到点
  await sessions.transition(id, 'GATE_A_RUNNING');
  await sessions.transition(id, 'GATE_A_FAILED', { dead_letter: 1, next_retry_at: Date.now() - 1, retry_count: 3 });
  await worker.tick();
  assert.equal((await sessions.get(id))!.state, 'GATE_A_FAILED'); // 死信不动
  assert.equal((await sessions.events(id)).some((e) => e.kind === 'auto_retry'), false);
});

test('tick：GATE_C_FAILED 瞬时失败退避到点 → reconcile 自动重试回 GATE_C_LOOP（SF1：不再「排了重试却静默卡死」）', async () => {
  notifyCalls.length = 0;
  benignMocks();
  const id = 'rt-gatec';
  await sessions.create({ id, slug: id, title: 'T', branch: 'dev' });
  for (const st of ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE', 'GATE_C_REQUESTED']) {
    await sessions.transition(id, st as never);
  }
  // 瞬时失败排了退避（有 worktree → planRetry 回 GATE_C_LOOP），退避已到点。
  gateCOutcome = { round: 2, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [] };
  await sessions.transition(id, 'GATE_C_FAILED', { worktree_path: '/wt/x', retry_count: 1, next_retry_at: Date.now() - 1 });
  // reconcileRetries 在 step 阶段之前跑 → 拾起 GATE_C_FAILED 翻 GATE_C_LOOP；同 tick step 跑（mock）实现循环暂停留在 LOOP。
  await worker.tick();
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_C_LOOP'); // 漏把 GATE_C_FAILED 纳入 reconcile 时会永远卡死在 GATE_C_FAILED
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'auto_retry' && (e.detail ?? '').includes('GATE_C_LOOP')));
});

test('retry(手动)：清死信 + 重试簿记，翻回可重跑态', async () => {
  benignMocks();
  const actions = await import('../src/actions.ts');
  const id = await mk('rt6', 'INTAKE');
  await sessions.transition(id, 'GATE_A_RUNNING');
  await sessions.transition(id, 'GATE_A_FAILED', { dead_letter: 1, retry_count: 3, next_retry_at: Date.now() + 999999 });
  const r = await actions.retry(id, 'M');
  assert.equal(r.ok, true);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'INTAKE'); // 无 pending_input → 回 INTAKE
  assert.equal(s.dead_letter, null);
  assert.equal(s.retry_count, null);
  assert.equal(s.next_retry_at, null);
});

// ── tick 锁陈旧判定（P2-I）──
test('lockActive：进程死=失效；活且未超期=活锁；活但超期=可接管；老格式无时戳=保守算活', () => {
  const aliveAll = () => true;
  const deadAll = () => false;
  const now = 1_000_000_000;
  assert.equal(worker.lockActive(`123\n${now}`, now, 1000, deadAll), false); // pid 死
  assert.equal(worker.lockActive(`123\n${now}`, now, 1000, aliveAll), true); // 活 + 刚持锁
  assert.equal(worker.lockActive(`123\n${now - 5000}`, now, 1000, aliveAll), false); // 活但超 maxHold → 可接管
  assert.equal(worker.lockActive('123', now, 1000, aliveAll), true); // 老格式无时戳 → 视为此刻=活
  assert.equal(worker.lockActive('', now, 1000, aliveAll), false); // 空 → 失效
});

test('lockMaxHoldSec：纯上游取 claude×6；下游按真实最长 tick 估（含 CI 自修 + parse-repair + per-tick 轮数），防长下游 tick 被误接管双跑', () => {
  const rt = (p: Record<string, unknown>) => p as unknown as Parameters<typeof worker.lockMaxHoldSec>[0];
  // 公式：(N+1)·(1+P)·(C+I)·(K+2)，K=MAX_CI_FIX_ATTEMPTS=2 →(K+2)=4；N=有效 per-tick 轮数；P=parse_repair_retries(默认2)。
  // 无下游配置 → 上游主导：1200×6=7200
  assert.equal(worker.lockMaxHoldSec(rt({ claude_timeout_sec: 1200 })), 7200);
  // 默认下游（claude 2400 / CI 1800 / parse-repair 2 / per-tick 缺省=1）：(1+1)·(1+2)·4200·4 = 100800 ≫ 上游 7200
  assert.equal(
    worker.lockMaxHoldSec(rt({ claude_timeout_sec: 1200, gate_c: { claude_timeout_sec: 2400, ci_timeout_sec: 1800 }, gate_d: { claude_timeout_sec: 2400, ci_timeout_sec: 1800 } })),
    100800,
  );
  // parse-repair 是真因子：同配置 P=0 → (1+1)·(1+0)·4200·4 = 33600（< P=2 的 100800，证明 parse-repair 被计入）。
  assert.equal(
    worker.lockMaxHoldSec(rt({ claude_timeout_sec: 1200, parse_repair_retries: 0, gate_d: { claude_timeout_sec: 2400, ci_timeout_sec: 1800 } })),
    33600,
  );
  // max_rounds_per_tick 也是真因子：闸D 调成每 tick 2 轮 → N=2 → (2+1)·3·4200·4 = 151200 > N=1 的 100800（防调参后双跑回归）。
  assert.equal(
    worker.lockMaxHoldSec(rt({ claude_timeout_sec: 1200, gate_d: { max_rounds: 3, max_rounds_per_tick: 2, claude_timeout_sec: 2400, ci_timeout_sec: 1800 } })),
    151200,
  );
  // 有效 N 受 max_rounds 钳制：per_tick=5 但 max_rounds=1 → N=1 → (1+1)·3·4200·4 = 100800（不被 per_tick 虚高撑爆）。
  assert.equal(
    worker.lockMaxHoldSec(rt({ claude_timeout_sec: 1200, gate_d: { max_rounds: 1, max_rounds_per_tick: 5, claude_timeout_sec: 2400, ci_timeout_sec: 1800 } })),
    100800,
  );
  // 下游 claude 未配 → 回退全局 1200，CI 取默认 1800：(1+1)·(1+2)·(1200+1800)·4 = 72000 > 上游
  assert.equal(worker.lockMaxHoldSec(rt({ claude_timeout_sec: 1200, gate_c: { max_rounds: 4 } })), 72000);
  // 地板 1h：极小配置不低于 3600
  assert.equal(worker.lockMaxHoldSec(rt({ claude_timeout_sec: 60, gate_c: { claude_timeout_sec: 60, ci_timeout_sec: 60 }, gate_d: { claude_timeout_sec: 60, ci_timeout_sec: 60 } })), 3600);
});

test('lockActive×lockMaxHoldSec：默认下游配置下，跑到「合法最长 tick（含 parse-repair + per-tick）」边界内不被接管、越界才接管（防双跑）', () => {
  const rt = { claude_timeout_sec: 1200, parse_repair_retries: 2, gate_c: { claude_timeout_sec: 2400, ci_timeout_sec: 1800 }, gate_d: { claude_timeout_sec: 2400, ci_timeout_sec: 1800 } };
  const holdMs = worker.lockMaxHoldSec(rt as unknown as Parameters<typeof worker.lockMaxHoldSec>[0]) * 1000; // 100800_000
  const alive = () => true;
  const now = 10_000_000_000;
  // 一个合法长下游 tick 刚跑到上界前一刻 → 仍是活锁，下个 tick 必须让路（不接管 → 不双跑）。
  assert.equal(worker.lockActive(`777\n${now - (holdMs - 1)}`, now, holdMs, alive), true);
  // 真超过上界（疑似挂死的手动 tick）→ 可接管。
  assert.equal(worker.lockActive(`777\n${now - (holdMs + 1)}`, now, holdMs, alive), false);
});

// ── tick 锁原子获取/接管（防双跑：双花钱 + 同一 worktree 互踩 git）──
test('acquireLock：wx 原子独占——空目录首取成功并写本 pid；本进程活着且新鲜 → 第二次让路', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-lock-'));
  const lock = join(dir, 'tick.lock');
  assert.equal(worker.acquireLock(lock), true);
  assert.match(readFileSync(lock, 'utf8'), new RegExp(`^${process.pid}\\n`));
  assert.equal(worker.acquireLock(lock), false, '本进程活着且新鲜 → 第二次取让路（不双跑）');
  worker.releaseLock(lock);
  assert.ok(!existsSync(lock));
  rmSync(dir, { recursive: true, force: true });
});

test('acquireLock：陈旧锁（持有者已死）→ 经 claim 仲裁接管，改写为本 pid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-lock-'));
  const lock = join(dir, 'tick.lock');
  writeFileSync(lock, `2147483646\n${Date.now()}`); // 极大 pid → kill(pid,0) ESRCH → pidAlive=false（死）
  assert.equal(worker.acquireLock(lock), true, '持有者已死 → 接管');
  assert.match(readFileSync(lock, 'utf8'), new RegExp(`^${process.pid}\\n`));
  assert.ok(!existsSync(`${lock}.claim`), '接管后 claim 已清');
  worker.releaseLock(lock);
  rmSync(dir, { recursive: true, force: true });
});

test('releaseLock：只删本 pid 持有的锁；他 pid 持有不动（不误删别人的活锁）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-lock-'));
  const lock = join(dir, 'tick.lock');
  writeFileSync(lock, `2147483646\n${Date.now()}`);
  worker.releaseLock(lock);
  assert.ok(existsSync(lock), '非本 pid 锁不被 release 删');
  writeFileSync(lock, `${process.pid}\n${Date.now()}`);
  worker.releaseLock(lock);
  assert.ok(!existsSync(lock), '本 pid 锁被删');
  rmSync(dir, { recursive: true, force: true });
});

test('acquireClaim：wx 独占仲裁——首抢成功；新鲜 claim 再抢让路（杜绝两个接管者都成功）；陈旧 claim 回收后可抢', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-claim-'));
  const claim = join(dir, 'tick.lock.claim');
  assert.equal(worker.acquireClaim(claim), true, '首抢');
  assert.equal(worker.acquireClaim(claim), false, '新鲜 claim 已被占 → 让路');
  writeFileSync(claim, `2147483646\n${Date.now() - 60_000}`); // 陈旧 claim（崩溃残留）
  assert.equal(worker.acquireClaim(claim), true, '陈旧 claim 回收后抢到');
  rmSync(dir, { recursive: true, force: true });
});

// ── 停泊态对账提醒（P2-F）──
test('remindStuck：未到阈值不打扰；久停泊重发卡；去抖期内不重复', async () => {
  notifyCalls.length = 0;
  benignMocks();
  const id = await mk('sk1', 'GATE_B_REQUESTED');
  await sessions.transition(id, 'GATE_B_RUNNING');
  await sessions.transition(id, 'ADVERSARIAL_LOOP');
  await sessions.transition(id, 'AWAITING_GO');

  // ① 刚停泊（now-updated_at≈0 < 6h）→ 不提醒
  await worker.remindStuck(Date.now());
  assert.equal((await sessions.events(id)).some((e) => e.kind === 'stuck_reminded'), false);
  assert.equal(notifyCalls.includes('needs_go'), false);

  // ② 模拟 7h 后（>6h）→ 重发卡
  const future = Date.now() + 7 * 3600 * 1000;
  await worker.remindStuck(future);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'stuck_reminded'));
  assert.ok(notifyCalls.includes('needs_go'));

  // ③ 去抖：12h 内不重复
  notifyCalls.length = 0;
  await worker.remindStuck(future);
  assert.equal((await sessions.events(id)).filter((e) => e.kind === 'stuck_reminded').length, 1);
  assert.equal(notifyCalls.includes('needs_go'), false);
});

test('remindStuck：已排程自动重试的 *_FAILED 不算停泊（不打扰）', async () => {
  notifyCalls.length = 0;
  benignMocks();
  const id = await mk('sk3', 'INTAKE');
  await sessions.transition(id, 'GATE_A_RUNNING');
  await sessions.transition(id, 'GATE_A_FAILED', { retry_count: 1, next_retry_at: Date.now() + 60000 }); // 退避中
  const future = Date.now() + 7 * 3600 * 1000;
  await worker.remindStuck(future);
  assert.equal((await sessions.events(id)).some((e) => e.kind === 'stuck_reminded'), false);
  // 但死信(automation 放弃)应提醒
  await sessions.patch(id, { dead_letter: 1, next_retry_at: null });
  await worker.remindStuck(future);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'stuck_reminded'));
  assert.ok(notifyCalls.includes('failed'));
});
