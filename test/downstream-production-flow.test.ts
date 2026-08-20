// 集成（不花钱）：下游**编排 wiring 组合回归**——DONE →(implement)→ 闸C 绿 →(review-pr)→ 开 PR → 闸D LGTM →
// 补强 → AWAITING_HUMAN_MERGE →(merged)→ SHIPPED。真实跑 actions + worker.step + 状态机 + sessions + notify，
// **各 gate 的 driver（建树/实现⇄CI/开PR/审diff/补强）整体 mock** → 验的是「这些环节如何被串起来」：状态闸、
// afterGateC/afterGateD/runGateDHardenStep 转移、green_sha pin、worktree 清理 wiring、通知、事件留痕、红线流转。
// ⚠️ 它**不验**真实 CI/真实 PR 委托/真实 diff 审/「CI 绿才推」/报告生成——那些是各 driver 自身的不变量，由
// gateDLoop.test / gateDHarden.test / gateC-setup.test 单点覆盖，真链路由手动冒烟（花钱）兜。这里是 wiring smoke，不是它们的替代。
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
const { loadConfig } = await import('../src/config.ts'); // 动态导入（绝不静态！静态会 hoist 到 FORGE_DB=:memory: 之前 → root.ts 落真库 → 并发串库）。桩回退真配置。

const notifyCalls: string[] = [];
const sessionsRef: { mod?: typeof import('../src/store/sessions.ts') } = {};
mock.module('../src/notify.ts', { namedExports: { notify: async (k: string) => { notifyCalls.push(k); }, syncGroupCard: async () => {} } });

// 上游 gate（本流程不走，但 worker.ts 模块级 import 它们）→ no-op mock。
mock.module('../src/gates/gateA.ts', { namedExports: { runGateA: async () => ({ round: 1, openQuestions: 0, resolved: true, stalled: false }), runGateARevision: async () => ({ round: 1, openQuestions: 0, resolved: true, stalled: false }) } });
mock.module('../src/gates/gateB.ts', { namedExports: { runGateB: async () => ({}), finalizeGateBDoc: () => {} } });
mock.module('../src/gates/gateBLoop.ts', { namedExports: { runGateBLoop: async () => ({ round: 1, verdict: 'clean', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] }) } });
mock.module('../src/gates/gateALoop.ts', { namedExports: { runGateALoop: async () => ({ round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] }), readGateAEnvelope: () => ({ summary: 's', open_questions: [], risks: [] }) } });
mock.module('../src/util/load.ts', { namedExports: { probeLoad: async () => [] } });

// ── 下游 driver mock（设真实闸会落的副作用：worktree/PR/绿态/报告）──
mock.module('../src/gates/gateC.ts', {
  namedExports: {
    runGateCSetup: async (s: { id: string }) => { sessionsRef.mod!.patch(s.id, { worktree_path: '/wt/x', impl_branch: 'forge/x', base_shas: JSON.stringify({ '.': 'BASESHA' }) }); },
    // 本流走旧单仓路径（setup 不落 legs → afterGateC 直接 AWAITING_GATE_D）；leg 切换由 worker/gateC 集成单测覆盖。
    activateLeg: () => {},
    activeLeg: () => null,
  },
});
const RESOLVED = { round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
mock.module('../src/gates/gateCLoop.ts', { namedExports: { runGateCLoop: async () => RESOLVED } });
mock.module('../src/gates/gateD.ts', { namedExports: { openReviewPr: async (s: { id: string }) => { sessionsRef.mod!.patch(s.id, { pr_url: 'https://x/pull/7', pr_number: 7 }); } } });
mock.module('../src/gates/gateDLoop.ts', { namedExports: { runGateDLoop: async () => RESOLVED, MAX_CI_FIX_ATTEMPTS: 2 } });
mock.module('../src/gates/gateDHarden.ts', { namedExports: { runGateDHarden: async (s: { id: string }) => { sessionsRef.mod!.patch(s.id, { gate_d_harden_round: 1, merge_readiness_path: '/wt/delivery/x/merge-readiness.md' }); } } });
// worktree 清理用计数 + 入参捕获 mock（断言 ackMerged 真把对的 path/branch/repoDir 传给清理，而非只看事件）。
let rmArg: { repoDir?: string; path?: string; removeScript?: string } | null = null;
let delArg: { repoDir: string; branch: string } | null = null;
mock.module('../src/util/worktree.ts', {
  namedExports: {
    worktreeHeadSha: () => 'GREENSHA',
    removeWorktree: async (o: { repoDir: string; path: string; removeScript?: string }) => { rmArg = o; return { ok: true, output: '' }; },
    deleteBranch: (repoDir: string, branch: string) => { delArg = { repoDir, branch }; },
    listWorktrees: () => [], // 孤儿清扫：列空 → sweep no-op（本测试不验清扫）
    planWorktreeSweep: () => [],
  },
});
const projStub = { id: 'p', root: '/proj', repos: ['.'], repoPath: () => '/proj/repo', deliveryDir: '/tmp', scripts: {} };
mock.module('../src/projects.ts', { namedExports: { projectForSession: () => projStub, project: () => projStub, defaultProjectId: () => 'p', configForProject: () => loadConfig(), configForSession: () => loadConfig() } });
// ackMerged 合并前经 workspace.prMergeState→gh pr view 核验。mock 整个 proc（仅 3 个导出，比偏 mock workspace
// 稳——偏 mock workspace 会让 issueStates 等静态导入在加载期报缺）。可切 prMerged 测「未合并→拒绝 / --force 越过」。
let prMerged = true;
mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (bin: string, args: string[]) => {
      if (bin === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return { code: 0, stdout: JSON.stringify({ state: prMerged ? 'MERGED' : 'OPEN' }), stderr: '', timedOut: false };
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    },
    runSync: () => '',
    commandExists: () => true,
  },
});

const sessions = await import('../src/store/sessions.ts');
sessionsRef.mod = sessions;
const worker = await import('../src/orchestrator/worker.ts');
const actions = await import('../src/actions.ts');

async function mkDone(id: string): Promise<void> {
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  for (const st of ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE']) {
    await sessions.transition(id, st as never);
  }
}

test('下游生产流：DONE→闸C绿→开PR→闸D LGTM→补强→AWAITING_HUMAN_MERGE→merged→SHIPPED（永不自动合并）', async () => {
  notifyCalls.length = 0;
  const id = 'dpf';
  await mkDone(id);

  // 1) implement（链式）→ GATE_C_REQUESTED
  assert.ok((await actions.requestGateC(id, 'M')).ok);
  assert.equal((await sessions.get(id))!.state, 'GATE_C_REQUESTED');

  // 2) tick：建 worktree + 实现⇄CI 绿 → AWAITING_GATE_D（待开 PR）
  await worker.step((await sessions.get(id))!);
  let s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_GATE_D');
  assert.equal(s.worktree_path, '/wt/x'); // 闸C 建了隔离树
  assert.ok(notifyCalls.includes('needs_review_pr'));

  // 3) review-pr → GATE_D_REQUESTED
  assert.ok((await actions.requestReviewPr(id, 'M')).ok);
  assert.equal((await sessions.get(id))!.state, 'GATE_D_REQUESTED');

  // 4) tick：开 PR → 闸D codex 审 diff⇄claude 修 LGTM → 进补强（pin 绿态 sha）
  await worker.step((await sessions.get(id))!);
  s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_D_HARDENING');
  assert.equal(s.pr_url, 'https://x/pull/7'); // 开了 PR
  assert.equal(s.gate_d_green_sha, 'GREENSHA'); // pin 了被 codex LGTM 的绿态（补强基线）

  // 5) tick：补强（补内环测试 + CI 绿 + 出 merge-readiness）→ 合并就绪（**停在人工合并**）
  await worker.step((await sessions.get(id))!);
  s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_HUMAN_MERGE'); // 红线：永不自动 merge
  assert.equal(s.merge_readiness_path, '/wt/delivery/x/merge-readiness.md');
  assert.ok(notifyCalls.includes('needs_merge'));

  // 6a) 核验红线：PR 实际未合并 → 拒绝，绝不清理、绝不 SHIPPED（取不到/未合并绝不当已合并）。
  prMerged = false;
  const refuse = await actions.ackMerged(id, 'M');
  assert.equal(refuse.ok, false, 'PR 未合并 → ackMerged 拒绝');
  assert.equal((await sessions.get(id))!.state, 'AWAITING_HUMAN_MERGE', '拒绝后状态不动');
  assert.equal(rmArg, null, '拒绝后绝不清理 worktree（不可逆动作未发生）');
  assert.ok((await sessions.events(id)).map((e) => e.kind).includes('merge_ack_refused'));

  // 6b) merged（人工确认已合并，gh 核验通过）→ SHIPPED（清隔离 worktree）。红线：SHIPPED 仅经 ackMerged 可达（永不自动）。
  prMerged = true;
  const r = await actions.ackMerged(id, 'M');
  assert.ok(r.ok);
  s = (await sessions.get(id))!;
  assert.equal(s.state, 'SHIPPED');
  assert.equal(s.merged_by, 'M');
  assert.ok(s.merged_at);
  // 清理 wiring：ackMerged 把对的 path/branch/repoDir 传给委托清理（不止看 worktree_cleaned 事件）。
  assert.deepEqual(rmArg, { repoDir: '/proj/repo', path: '/wt/x', removeScript: undefined });
  assert.deepEqual(delArg, { repoDir: '/proj/repo', branch: 'forge/x' });

  // 全程事件留痕齐全 + 终态正确
  const kinds = (await sessions.events(id)).map((e) => e.kind);
  for (const k of ['gate_c_done', 'gate_d_done', 'gate_d_hardened', 'merged', 'worktree_cleaned']) {
    assert.ok(kinds.includes(k), `缺事件 ${k}`);
  }
});

test('下游红线：权限闸——非 merge_ack_allowed 不能确认合并；非 AWAITING_HUMAN_MERGE 不能 merged', async () => {
  const id = 'dpf2';
  await mkDone(id);
  // 还没到合并就绪 → merged 拒绝
  assert.equal((await actions.ackMerged(id, 'M')).ok, false);
  // 推到 AWAITING_HUMAN_MERGE
  await actions.requestGateC(id, 'M');
  await worker.step((await sessions.get(id))!);
  await actions.requestReviewPr(id, 'M');
  await worker.step((await sessions.get(id))!);
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_HUMAN_MERGE');
  // 无权限者确认 → 拒绝、状态不变
  assert.equal((await actions.ackMerged(id, 'ZZ')).ok, false);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_HUMAN_MERGE');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'permission_denied'));
});

test('ackMerged --force：gh 核验未合并也可人工越过 → SHIPPED + 留 forced 审计', async () => {
  const id = 'dpf3';
  await mkDone(id);
  await actions.requestGateC(id, 'M');
  await worker.step((await sessions.get(id))!);
  await actions.requestReviewPr(id, 'M');
  await worker.step((await sessions.get(id))!);
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_HUMAN_MERGE');
  prMerged = false; // gh 说未合并
  assert.equal((await actions.ackMerged(id, 'M')).ok, false, '不 force → 拒绝');
  const r = await actions.ackMerged(id, 'M', { force: true });
  assert.ok(r.ok, '--force 越过核验');
  assert.equal((await sessions.get(id))!.state, 'SHIPPED');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'merge_ack_forced'));
  prMerged = true; // 还原共享态
});

test('mergeAckDecision：已核验合并→放行；未合并/查不到→拒绝；--force 一律越过并标 forced', () => {
  assert.equal(actions.mergeAckDecision({ ok: true, merged: true, state: 'MERGED' }, false).proceed, true);
  assert.equal(actions.mergeAckDecision({ ok: true, merged: false, state: 'OPEN' }, false).proceed, false);
  assert.equal(actions.mergeAckDecision({ ok: false, merged: false, state: 'UNKNOWN', error: 'gh 失败' }, false).proceed, false);
  const forced = actions.mergeAckDecision({ ok: true, merged: false, state: 'OPEN' }, true);
  assert.equal(forced.proceed, true);
  assert.equal(forced.forced, true);
});
