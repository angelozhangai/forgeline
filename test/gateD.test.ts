// 集成：闸D 人工动作（requestReviewPr 触发开 PR / submitGateDAnswers 答复升级·裁决）的权限闸与状态流转。
// 真 permissions.yaml（pr_create_approvers=[M]）；mock 飞书/写动作/负载探针。
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
const { loadConfig } = await import('../src/config.ts'); // 动态导入（绝不静态！静态会 hoist 到 FORGE_DB=:memory: 之前 → root.ts 落真库 → 并发串库）。桩回退真配置。

mock.module('../src/notify.ts', { namedExports: { notify: async () => {}, syncGroupCard: async () => {} } });
mock.module('../src/writes.ts', { namedExports: { doWrites: async () => ({ ok: true, stdout: '', issues: [] }) } });
mock.module('../src/util/load.ts', { namedExports: { probeLoad: async () => [] } });
// repoPath 按仓返回（多仓 ackMerged 须逐仓在各自 repoDir 清理；单仓 '.' 维持 /proj/repo 不变）。
mock.module('../src/projects.ts', {
  namedExports: { projectForSession: () => ({ id: 'p', root: '/proj', repos: ['.'], repoPath: (r: string) => (r === '.' ? '/proj/repo' : `/proj/${r}`), deliveryDir: '/tmp', scripts: {} }), configForProject: () => loadConfig(), configForSession: () => loadConfig() },
});
// ackMerged 清隔离 worktree：mock 成可计数 + 入参捕获（多仓断言逐仓在各自 repoDir 清理）的 no-op（不起真 git）。
let removeCalls = 0;
let deleteCalls = 0;
let rmRepoDirs: string[] = [];
let delRepoDirs: string[] = [];
mock.module('../src/util/worktree.ts', {
  namedExports: {
    removeWorktree: async (o: { repoDir: string }) => { removeCalls++; rmRepoDirs.push(o.repoDir); return { ok: true, output: '' }; },
    deleteBranch: (repoDir: string) => { deleteCalls++; delRepoDirs.push(repoDir); },
  },
});
// ackMerged 合并前经 prMergeState→gh pr view <url> 核验。本测试不跑真 git，mock proc 让 gh 返回可切的合并态。
// ghStateByUrl 非空 → 按 PR url(args[2]) 逐个返回（多仓「部分合并」场景）；否则回退全局 ghMerged。
let ghMerged = true;
let ghStateByUrl: Record<string, string> | null = null;
mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (bin: string, args: string[]) => {
      if (bin === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        const state = ghStateByUrl ? (ghStateByUrl[args[2]] ?? 'OPEN') : ghMerged ? 'MERGED' : 'OPEN';
        return { code: 0, stdout: JSON.stringify({ state }), stderr: '', timedOut: false };
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    },
    runSync: () => '',
    commandExists: () => true,
  },
});

const sessions = await import('../src/store/sessions.ts');
const actions = await import('../src/actions.ts');
const { mkLeg } = await import('../src/gates/legs.ts');

let n = 0;
const toDone = ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE'];
const toAwaitD = [...toDone, 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'AWAITING_GATE_D'];
async function at(target: string): Promise<string> {
  const id = `d${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  const path: Record<string, string[]> = {
    AWAITING_GATE_D: toAwaitD,
    GATE_D_REQUESTED: [...toAwaitD, 'GATE_D_REQUESTED'],
    AWAITING_GATE_D_INPUT: [...toAwaitD, 'GATE_D_REQUESTED', 'GATE_D_LOOP', 'AWAITING_GATE_D_INPUT'],
    GATE_D_STALLED: [...toAwaitD, 'GATE_D_REQUESTED', 'GATE_D_LOOP', 'GATE_D_STALLED'],
    AWAITING_HUMAN_MERGE: [...toAwaitD, 'GATE_D_REQUESTED', 'GATE_D_LOOP', 'GATE_D_HARDENING', 'AWAITING_HUMAN_MERGE'],
    SHIPPED: [...toAwaitD, 'GATE_D_REQUESTED', 'GATE_D_LOOP', 'GATE_D_HARDENING', 'AWAITING_HUMAN_MERGE', 'SHIPPED'],
    DONE: toDone,
  };
  for (const st of path[target] ?? []) await sessions.transition(id, st as never);
  return id;
}

test('requestReviewPr：AWAITING_GATE_D + 有权限(M) → GATE_D_REQUESTED', async () => {
  const id = await at('AWAITING_GATE_D');
  const r = await actions.requestReviewPr(id, 'M');
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'GATE_D_REQUESTED');
  assert.equal((await sessions.get(id))!.gate_d_requested_by, 'M');
});

test('requestReviewPr：非 AWAITING_GATE_D 态拒绝（需先闸C 绿）', async () => {
  const id = await at('DONE');
  const r = await actions.requestReviewPr(id, 'M');
  assert.equal(r.ok, false);
  assert.match(r.msg, /AWAITING_GATE_D/);
  assert.equal((await sessions.get(id))!.state, 'DONE');
});

test('requestReviewPr：无权限者被拒、状态不变 + 记 permission_denied', async () => {
  const id = await at('AWAITING_GATE_D');
  const r = await actions.requestReviewPr(id, 'ZZ');
  assert.equal(r.ok, false);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GATE_D');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'permission_denied'));
});

test('requestReviewPr：已 GATE_D_REQUESTED 幂等 ok', async () => {
  const id = await at('GATE_D_REQUESTED');
  assert.ok((await actions.requestReviewPr(id, 'M')).ok);
});

test('submitGateDAnswers：AWAITING_GATE_D_INPUT → GATE_D_REVISION_REQUESTED + 落 pending_input', async () => {
  const id = await at('AWAITING_GATE_D_INPUT');
  const r = await actions.submitGateDAnswers(id, 'M', '采纳 codex 第2条，按方案A 改');
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_D_REVISION_REQUESTED');
  assert.equal(s.gate_d_pending_input, '采纳 codex 第2条，按方案A 改');
});

test('submitGateDAnswers：GATE_D_STALLED 裁决 → 续修；空答复也按再修一轮', async () => {
  const id = await at('GATE_D_STALLED');
  const r = await actions.submitGateDAnswers(id, 'M');
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'GATE_D_REVISION_REQUESTED');
});

test('submitGateDAnswers：错误态/无权限拒绝', async () => {
  assert.equal((await actions.submitGateDAnswers(await at('AWAITING_GATE_D'), 'M')).ok, false); // 非答复态
  assert.equal((await actions.submitGateDAnswers(await at('AWAITING_GATE_D_INPUT'), 'ZZ')).ok, false); // 无权限
});

test('ackMerged：AWAITING_HUMAN_MERGE + 有权限(M) → SHIPPED + 清 worktree（永不自动合并，这是人工确认）', async () => {
  removeCalls = 0; deleteCalls = 0;
  const id = await at('AWAITING_HUMAN_MERGE');
  await sessions.patch(id, { worktree_path: '/wt/x', impl_branch: 'forge/x', pr_url: 'https://x/pull/9' });
  const r = await actions.ackMerged(id, 'M');
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'SHIPPED');
  assert.equal(s.merged_by, 'M');
  assert.ok(s.merged_at);
  assert.equal(removeCalls, 1); // 清隔离 worktree
  assert.equal(deleteCalls, 1); // 删实现分支
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'merged'));
});

test('ackMerged：gh 核验 PR 未合并 → 拒绝，绝不清理/绝不 SHIPPED（取不到/未合并绝不当已合并）', async () => {
  removeCalls = 0; deleteCalls = 0;
  const id = await at('AWAITING_HUMAN_MERGE');
  await sessions.patch(id, { worktree_path: '/wt/x', impl_branch: 'forge/x', pr_url: 'https://x/pull/9' });
  ghMerged = false;
  const r = await actions.ackMerged(id, 'M');
  ghMerged = true; // 还原共享态
  assert.equal(r.ok, false);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_HUMAN_MERGE'); // 状态不动
  assert.equal(removeCalls, 0); // 不可逆清理绝不发生
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'merge_ack_refused'));
});

test('ackMerged：非 AWAITING_HUMAN_MERGE 态拒绝（需先合并就绪）', async () => {
  const r = await actions.ackMerged(await at('AWAITING_GATE_D'), 'M');
  assert.equal(r.ok, false);
  assert.match(r.msg, /AWAITING_HUMAN_MERGE/);
});

test('ackMerged：无权限者被拒、状态不变 + 记 permission_denied（worktree 不动）', async () => {
  removeCalls = 0;
  const id = await at('AWAITING_HUMAN_MERGE');
  const r = await actions.ackMerged(id, 'ZZ');
  assert.equal(r.ok, false);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_HUMAN_MERGE');
  assert.equal(removeCalls, 0); // 鉴权挡在清理之前
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'permission_denied'));
});

test('ackMerged：已 SHIPPED 幂等 ok', async () => {
  assert.ok((await actions.ackMerged(await at('SHIPPED'), 'M')).ok);
});

// ── Phase 2c：多仓「每仓一树一PR」——ackMerged 逐 leg 核验各自 PR，全合并才清所有 leg worktree + SHIPPED ──
async function awaitMergeWithLegs(legs: { repo: string; pr: string }[]): Promise<string> {
  const id = await at('AWAITING_HUMAN_MERGE');
  await sessions.patch(id, {
    legs: JSON.stringify(legs.map((l) => mkLeg(l.repo, { worktree_path: `/wt/${l.repo}`, impl_branch: 'forge/k', pr_url: l.pr, gate_d_harden_verified_sha: 'V' }))),
  });
  return id;
}

test('ackMerged（多仓/2c）：全部 leg PR 已合并 → SHIPPED + 逐仓清 worktree（各在各自仓 repoDir）+ 各 leg 标 merged', async () => {
  removeCalls = 0; deleteCalls = 0; rmRepoDirs = []; delRepoDirs = [];
  ghStateByUrl = { 'https://x/pull/11': 'MERGED', 'https://x/pull/22': 'MERGED' };
  const id = await awaitMergeWithLegs([{ repo: 'demo', pr: 'https://x/pull/11' }, { repo: 'example-web', pr: 'https://x/pull/22' }]);
  const r = await actions.ackMerged(id, 'M');
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'SHIPPED');
  assert.equal(removeCalls, 2); // 两条 leg 各清一次
  assert.deepEqual(rmRepoDirs.slice().sort(), ['/proj/demo', '/proj/example-web']); // 各在各自仓
  assert.deepEqual(delRepoDirs.slice().sort(), ['/proj/demo', '/proj/example-web']);
  const ls = JSON.parse((await sessions.get(id))!.legs!) as { merged: boolean }[];
  assert.ok(ls.every((l) => l.merged === true)); // 各 leg 标 merged
  ghStateByUrl = null; // 还原共享态
});

test('ackMerged（多仓/2c）：任一 leg PR 未合并 → 拒绝，绝不清理/绝不 SHIPPED（红线：不在有 leg 未合并时整条宣告 shipped）', async () => {
  removeCalls = 0;
  ghStateByUrl = { 'https://x/pull/11': 'MERGED', 'https://x/pull/22': 'OPEN' }; // example 未合并
  const id = await awaitMergeWithLegs([{ repo: 'demo', pr: 'https://x/pull/11' }, { repo: 'example-web', pr: 'https://x/pull/22' }]);
  const r = await actions.ackMerged(id, 'M');
  assert.equal(r.ok, false);
  assert.match(r.msg, /example-web/);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_HUMAN_MERGE'); // 状态不动
  assert.equal(removeCalls, 0); // 绝不清理（不可逆动作未发生）
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'merge_ack_refused'));
  ghStateByUrl = null;
});

test('ackMerged --force（多仓/2c）：部分未合并也可人工越过 → SHIPPED + 留 forced 审计', async () => {
  removeCalls = 0;
  ghStateByUrl = { 'https://x/pull/11': 'MERGED', 'https://x/pull/22': 'OPEN' };
  const id = await awaitMergeWithLegs([{ repo: 'demo', pr: 'https://x/pull/11' }, { repo: 'example-web', pr: 'https://x/pull/22' }]);
  assert.equal((await actions.ackMerged(id, 'M')).ok, false, '不 force → 拒绝');
  const r = await actions.ackMerged(id, 'M', { force: true });
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'SHIPPED');
  assert.equal(removeCalls, 2);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'merge_ack_forced'));
  ghStateByUrl = null;
});
