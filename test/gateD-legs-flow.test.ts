// 集成（不花钱）：Phase 2c 闸D 多仓「每仓一树一PR」**顺序驱动 wiring**——用**真** gateC（activateLeg/activeLeg）+ 真 legs
// + 真 worker.step + 真状态机，只 mock 各 driver（开PR/审diff/补强）。验的是 worker 如何把闸D 逐 leg 串起来：
//  · GATE_D_REQUESTED 开完 N 个 PR 后**重指 primary leg**（修 Codex 2c Blocker：否则审最后那条 gate-C leg 却挂 primary PR）。
//  · 每条 leg 补强完 → 持久化其闸D 终态回 leg → 切下一条回 GATE_D_LOOP；**全部 leg 补强完才** AWAITING_HUMAN_MERGE。
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
const { loadConfig } = await import('../src/config.ts'); // 动态导入（绝不静态！静态会 hoist 到 FORGE_DB=:memory: 之前 → root.ts 落真库 → 并发串库）。桩回退真配置。

const notifyCalls: string[] = [];
const sessionsRef: { mod?: typeof import('../src/store/sessions.ts') } = {};
mock.module('../src/notify.ts', { namedExports: { notify: async (k: string) => { notifyCalls.push(k); }, syncGroupCard: async () => {} } });

// 上游 gate（本流程不走，worker 模块级 import）→ no-op。
mock.module('../src/gates/gateA.ts', { namedExports: { runGateA: async () => ({ round: 1, openQuestions: 0, resolved: true, stalled: false }), runGateARevision: async () => ({ round: 1, openQuestions: 0, resolved: true, stalled: false }) } });
mock.module('../src/gates/gateB.ts', { namedExports: { runGateB: async () => ({}), finalizeGateBDoc: () => {} } });
mock.module('../src/gates/gateBLoop.ts', { namedExports: { runGateBLoop: async () => ({ round: 1, verdict: 'clean', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] }) } });
mock.module('../src/gates/gateALoop.ts', { namedExports: { runGateALoop: async () => ({ round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] }), readGateAEnvelope: () => ({ summary: 's', open_questions: [], risks: [] }) } });
mock.module('../src/util/load.ts', { namedExports: { probeLoad: async () => [] } });
mock.module('../src/gates/gateCLoop.ts', { namedExports: { runGateCLoop: async () => ({ round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] }) } });

const RESOLVED = { round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
mock.module('../src/gates/gateDLoop.ts', { namedExports: { runGateDLoop: async () => RESOLVED, MAX_CI_FIX_ATTEMPTS: 2 } });
// 开 PR（mock 真实副作用）：逐 leg 落 pr_url + session.pr_url=primary，但**不动 worktree_path**（仍停最后那条 gate-C leg）——
// 复现 Blocker 前置态，验 worker 是否重指回 primary。
mock.module('../src/gates/gateD.ts', {
  namedExports: {
    openReviewPr: async (s: { id: string }) => {
      const cur = (await sessionsRef.mod!.get(s.id))!;
      const legs = (JSON.parse(cur.legs!) as { repo: string }[]).map((l, i) => ({ ...l, pr_url: `https://x/pull/${i === 0 ? 11 : 22}`, pr_number: i === 0 ? 11 : 22 }));
      await sessionsRef.mod!.patch(s.id, { legs: JSON.stringify(legs), pr_url: legs[0].pr_url, pr_number: legs[0].pr_number });
    },
  },
});
// 补强（mock）：置 harden_round + 已验证 sha + 报告（真 harden 会 pin verified sha；worker 据此把该 leg 标过闸D）。
mock.module('../src/gates/gateDHarden.ts', {
  namedExports: {
    runGateDHarden: async (s: { id: string }) => {
      const cur = (await sessionsRef.mod!.get(s.id))!;
      const repo = cur.worktree_path === UWT ? 'example-web' : 'demo';
      await sessionsRef.mod!.patch(s.id, { gate_d_harden_round: 1, gate_d_harden_verified_sha: `VERIFIED-${repo}`, merge_readiness_path: `/tmp/mr.${repo}.md` });
    },
  },
});
// worktree：用真 gateC（activateLeg/activeLeg），故须导出 gateC 用到的全部（createWorktree/defaultWorktreePath/ensureWorktreeExcluded）+ worker 用的。
mock.module('../src/util/worktree.ts', {
  namedExports: {
    worktreeHeadSha: () => 'GREENSHA',
    createWorktree: async () => ({ ok: true, output: '' }),
    removeWorktree: async () => ({ ok: true, output: '' }),
    deleteBranch: () => {},
    listWorktrees: () => [],
    planWorktreeSweep: () => [],
    defaultWorktreePath: (repoDir: string, key: string) => `${repoDir}/.forge/worktrees/${key}`,
    ensureWorktreeExcluded: () => {},
  },
});
const projStub = { id: 'p', root: '/proj', repos: ['demo', 'example-web'], repoPath: (r: string) => `/proj/${r}`, deliveryDir: '/tmp', scripts: {} };
mock.module('../src/projects.ts', { namedExports: { projectForSession: () => projStub, project: () => projStub, defaultProjectId: () => 'p', configForProject: () => loadConfig(), configForSession: () => loadConfig() } });
mock.module('../src/util/proc.ts', { namedExports: { run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }), runSync: () => '', commandExists: () => true } });
// 下游交付文档提交（worker 在「全部 leg 补强完进合并就绪」时调）：捕获调用，模拟已提交。doWrites 桩供 actions import（本流不调）。
const deliveryDocCalls: string[] = [];
mock.module('../src/writes.ts', {
  namedExports: {
    maybeCommitDeliveryDocs: async (s: { id: string }) => { deliveryDocCalls.push(s.id); return { ok: true, committed: true }; },
    doWrites: async () => ({ ok: true, stdout: '', issues: [] }),
  },
});

const sessions = await import('../src/store/sessions.ts');
sessionsRef.mod = sessions;
const worker = await import('../src/orchestrator/worker.ts');
const { mkLeg, getLegs } = await import('../src/gates/legs.ts');

const CWT = '/proj/demo/.forge/worktrees/k';
const UWT = '/proj/example-web/.forge/worktrees/k';

// 建一条停在 GATE_D_REQUESTED、已建两腿、session 停在**最后一条 gate-C leg（example）**的 session（复现 Blocker 前置态）。
async function mkTwoLegAtGateDRequested(id: string): Promise<void> {
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  for (const st of ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE', 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'AWAITING_GATE_D', 'GATE_D_REQUESTED']) {
    await sessions.transition(id, st as never);
  }
  await sessions.patch(id, {
    legs: JSON.stringify([
      mkLeg('demo', { worktree_path: CWT, impl_branch: 'forge/k', base_sha: 'C', ci_ok: true }),
      mkLeg('example-web', { worktree_path: UWT, impl_branch: 'forge/k', base_sha: 'U', ci_ok: true }),
    ]),
    worktree_path: UWT, // 闸C 最后处理的是 example → session 停在它（不是 primary）
    base_shas: JSON.stringify({ 'example-web': 'U' }),
  });
}

test('多仓闸D：GATE_D_REQUESTED 开完 2 个 PR → **重指 primary(demo)** 进 GATE_D_LOOP→LGTM→HARDENING（不再审最后那条 leg）', async () => {
  notifyCalls.length = 0;
  const id = 'gdl1';
  await mkTwoLegAtGateDRequested(id);
  await worker.step((await sessions.get(id))!); // openPR → 重指 primary → LOOP → LGTM → HARDENING（一气到停顿点）
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_D_HARDENING');
  assert.equal(s.worktree_path, CWT, '重指回 primary(demo)——绝不停在最后那条 gate-C leg(example)'); // 修 Blocker 的关键
  assert.equal(s.pr_url, 'https://x/pull/11', 'session.pr_url = primary(demo) 的 PR');
  assert.equal(s.gate_d_green_sha, 'GREENSHA'); // afterGateD 在 primary worktree 上 pin 绿态
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_d_leg_active'));
});

test('多仓闸D：primary 补强完 → 切 example 回 GATE_D_LOOP；demo leg 落「过闸D」终态', async () => {
  const id = 'gdl2';
  await mkTwoLegAtGateDRequested(id);
  await worker.step((await sessions.get(id))!); // → GATE_D_HARDENING（demo）
  await worker.step((await sessions.get(id))!); // 补强 demo → 切 example → GATE_D_LOOP
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_D_LOOP');
  assert.equal(s.worktree_path, UWT, '已切到第二条 leg(example)');
  assert.equal(s.pr_url, 'https://x/pull/22', 'pr_url 对齐到 example');
  const legs = getLegs(s);
  assert.equal(legs.find((l) => l.repo === 'demo')!.gate_d_harden_verified_sha, 'VERIFIED-demo', 'demo leg 已落过闸D 终态');
  assert.equal(legs.find((l) => l.repo === 'demo')!.merge_readiness_path, '/tmp/mr.demo.md', 'demo leg 保留自己的合并就绪报告');
  assert.equal(legs.find((l) => l.repo === 'example-web')!.gate_d_harden_verified_sha, null, 'example 尚未');
  assert.equal(s.gate_d_harden_round, null, '切 leg 重置了闸D 循环态');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_d_leg_done'));
  assert.ok(!(await sessions.events(id)).some((e) => e.kind === 'delivery_docs_committed'), 'leg 中途推进绝不提交交付文档（只在全部补强完才提交）');
});

test('多仓闸D：两条 leg 都补强完才 AWAITING_HUMAN_MERGE + needs_merge（红线：永不自动合并）', async () => {
  notifyCalls.length = 0;
  const id = 'gdl3';
  await mkTwoLegAtGateDRequested(id);
  await worker.step((await sessions.get(id))!); // demo: openPR→重指→LGTM→HARDENING
  await worker.step((await sessions.get(id))!); // demo 补强 → 切 example → GATE_D_LOOP
  assert.equal((await sessions.get(id))!.state, 'GATE_D_LOOP'); // 仍在闸D（绝不在 demo 一条绿时就合并就绪）
  await worker.step((await sessions.get(id))!); // example: LGTM → HARDENING
  assert.equal((await sessions.get(id))!.state, 'GATE_D_HARDENING');
  await worker.step((await sessions.get(id))!); // example 补强 → 全部过闸D → AWAITING_HUMAN_MERGE
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_HUMAN_MERGE');
  assert.ok(notifyCalls.includes('needs_merge'));
  const legs = getLegs(s);
  assert.deepEqual(legs.map((l) => [l.repo, l.gate_d_harden_verified_sha, l.merge_readiness_path]), [
    ['demo', 'VERIFIED-demo', '/tmp/mr.demo.md'],
    ['example-web', 'VERIFIED-example-web', '/tmp/mr.example-web.md'],
  ], '两条 leg 都过闸D，且各自保留自己的合并就绪报告');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_d_hardened'));
  // 下游交付文档（含两仓各自 merge-readiness）此刻一并归档（config 门控，绝不 push）。
  assert.ok(deliveryDocCalls.includes(id), '进合并就绪时触发一次下游交付文档提交');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'delivery_docs_committed'), '提交成功留 delivery_docs_committed 事件');
});
