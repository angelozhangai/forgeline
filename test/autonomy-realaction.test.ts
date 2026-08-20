// 集成（Codex SF4）：worker.applyAutonomy 接的是**真** actions（不 mock），证明自治自动路径真的继承生产 action 的
// 权限闸 / 指派闸 / 状态机红线——而非只验「调了某个函数名」。只 mock 外部边界：写动作 doWrites（计数，断言「未写」）、
// 项目解析（控自治 level/actor）、notify/load。真：actions.ts、真 config（permissions: go_approvers/gate_b_allowed=[M,...]）、状态机、sessions。
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
const { loadConfig } = await import('../src/config.ts'); // 动态导入（绝不静态！静态会 hoist 到 FORGE_DB=:memory: 之前 → root.ts 落真库 → 并发串库）。桩回退真配置。

let autonomyLevel = 0;
let autonomyActor = 'M';
const projStub = { id: 'demo', root: '/proj', repos: ['demo'], repoPath: (r: string) => `/proj/${r}`, repoMap: { C: 'demo' }, umbrella: 'example-project', scripts: {}, deliveryDir: '/proj/docs/delivery', autonomy: { level: autonomyLevel, actor: autonomyActor } };
mock.module('../src/projects.ts', {
  namedExports: {
    projectForSession: () => ({ ...projStub, autonomy: { level: autonomyLevel, actor: autonomyActor } }),
    project: () => ({ ...projStub, autonomy: { level: autonomyLevel, actor: autonomyActor } }),
    projectForChat: () => undefined,
    defaultProjectId: () => 'demo',
    configForProject: () => loadConfig(),
    configForSession: () => loadConfig(),
  },
});
// 写动作边界：计数 doWrites，断言被自治拦下的 GO「根本没写」。
let doWritesCalls = 0;
mock.module('../src/writes.ts', {
  namedExports: {
    doWrites: async () => { doWritesCalls++; return { ok: true, stdout: '', issues: [] }; },
    maybeCommitDeliveryDocs: async () => ({ ok: true, committed: false }),
  },
});
mock.module('../src/notify.ts', { namedExports: { notify: async () => {}, syncGroupCard: async () => {} } });
mock.module('../src/util/load.ts', { namedExports: { probeLoad: async () => [] } });

const sessions = await import('../src/store/sessions.ts');
const { db } = await import('../src/store/db.ts');
const worker = await import('../src/orchestrator/worker.ts');

const PATH = ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE', 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'AWAITING_GATE_D', 'GATE_D_REQUESTED', 'GATE_D_LOOP', 'GATE_D_HARDENING', 'AWAITING_HUMAN_MERGE'];
let n = 0;
async function mkAt(target: string): Promise<string> {
  const id = `r${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  for (const st of PATH) { await sessions.transition(id, st as never); if (st === target) return id; }
  return id;
}
async function mkStalled(): Promise<string> {
  const id = `r${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  for (const st of ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE', 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'GATE_C_STALLED']) await sessions.transition(id, st as never);
  return id;
}

beforeEach(() => { db().exec('DELETE FROM session; DELETE FROM event_log;'); doWritesCalls = 0; autonomyLevel = 0; autonomyActor = 'M'; });

test('真 action·L4：AWAITING_GATE_D → 真 requestReviewPr 推进 GATE_D_REQUESTED；红线态 AWAITING_HUMAN_MERGE/GATE_C_STALLED 纹丝不动', async () => {
  autonomyLevel = 4;
  const dId = await mkAt('AWAITING_GATE_D');
  const mId = await mkAt('AWAITING_HUMAN_MERGE');
  const sId = await mkStalled();
  await worker.applyAutonomy();
  assert.equal((await sessions.get(dId))!.state, 'GATE_D_REQUESTED', '真 requestReviewPr 推进（权限+状态机都过）');
  assert.equal((await sessions.get(mId))!.state, 'AWAITING_HUMAN_MERGE', '红线#1：永不自动 merge —— 态不动');
  assert.equal((await sessions.get(sId))!.state, 'GATE_C_STALLED', '红线#2：确定性闸 —— 态不动');
});

test('真 action·权限继承：actor 不在权限名单 → 真 requestGateB 被拒，CONFIRMED 态不动 + permission_denied', async () => {
  autonomyLevel = 1;
  autonomyActor = 'NOPE'; // 不在 gate_b_allowed
  const id = await mkAt('CONFIRMED');
  await worker.applyAutonomy();
  assert.equal((await sessions.get(id))!.state, 'CONFIRMED', '权限不过 → 真 action 不转移');
  const evs = await sessions.events(id);
  assert.ok(evs.some((e) => e.kind === 'permission_denied'), '真 action 落 permission_denied');
  const res = evs.find((e) => e.kind === 'autonomy_auto_result');
  assert.equal(JSON.parse(res!.detail ?? '{}').ok, false);
});

test('真 action·指派闸继承：auto-GO 未指派 DRI → 真 go 受阻，AWAITING_GO 态不动 + go_blocked_no_assignee + **doWrites 零调用（绝无外向写）**', async () => {
  autonomyLevel = 2;
  const id = await mkAt('AWAITING_GO'); // 手动转移到此，未跑 autoAssignOnGo → assignee 为空
  await worker.applyAutonomy();
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO', '指派闸未过 → 真 go 不立项、态不动');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'go_blocked_no_assignee'), '真 go 落指派阻塞事件');
  assert.equal(doWritesCalls, 0, '红线#3：写动作前确定性闸未过 → 根本没调 doWrites（无外向写）');
});

test('真 action·权限通过：actor=M（在 go_approvers）·L4·AWAITING_GATE_D → 真 requestReviewPr 推进', async () => {
  autonomyLevel = 4;
  const id = await mkAt('AWAITING_GATE_D');
  await worker.applyAutonomy();
  assert.equal((await sessions.get(id))!.state, 'GATE_D_REQUESTED');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'autonomy_auto_triggered'));
});
