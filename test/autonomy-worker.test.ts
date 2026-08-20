// 集成：worker.applyAutonomy 接线——停泊在授权点的 session 按**项目**自治等级自动触发对应 action + 落审计事件。
// 验：默认 L0 零动作；L2 触发 requestGateB+go 不触发更高的；L4 全触发；红线态（merge/确定性 stall）永不被触发；
// 动作 !ok（权限/lint 不过）不落审计、留人工；署名 = 配置 actor。mock projects(控 level/actor) + actions(捕获)。
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
const { loadConfig } = await import('../src/config.ts'); // 动态导入（绝不静态！静态会 hoist 到 FORGE_DB=:memory: 之前 → root.ts 落真库 → 并发串库）。桩回退真配置。

let autonomyLevel = 0;
let autonomyActor = 'M';
mock.module('../src/projects.ts', {
  namedExports: {
    projectForSession: () => ({ autonomy: { level: autonomyLevel, actor: autonomyActor } }),
    project: () => ({ autonomy: { level: autonomyLevel, actor: autonomyActor } }),
    projectForChat: () => undefined,
    defaultProjectId: () => 'demo',
    configForProject: () => loadConfig(),
    configForSession: () => loadConfig(),
  },
});

// 捕获被自治触发的 4 个动作；markReviewActive/autoAssignOnGo 是 worker 也 import 的桩。
let calls: { fn: string; by: string }[] = [];
let actionOk = true;
const cap = (fn: string) => (_slug: string, by: string) => { calls.push({ fn, by }); return { ok: actionOk, msg: actionOk ? 'ok' : '无权限/lint 未过' }; };
mock.module('../src/actions.ts', {
  namedExports: {
    markReviewActive: () => {},
    autoAssignOnGo: async () => {},
    requestGateB: async (slug: string, by: string) => cap('requestGateB')(slug, by),
    go: async (slug: string, by: string) => cap('go')(slug, by),
    requestGateC: (slug: string, by: string) => cap('requestGateC')(slug, by),
    requestReviewPr: (slug: string, by: string) => cap('requestReviewPr')(slug, by),
  },
});
mock.module('../src/notify.ts', { namedExports: { notify: async () => {}, syncGroupCard: async () => {} } });
mock.module('../src/util/load.ts', { namedExports: { probeLoad: async () => [] } });

const sessions = await import('../src/store/sessions.ts');
const { db } = await import('../src/store/db.ts');
const worker = await import('../src/orchestrator/worker.ts');

// 各授权停泊点 + 红线态的合法转移路径（按管线序，切到目标态）。
const PATH = ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE', 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'AWAITING_GATE_D', 'GATE_D_REQUESTED', 'GATE_D_LOOP', 'GATE_D_HARDENING', 'AWAITING_HUMAN_MERGE'];
let n = 0;
async function mkAt(target: string): Promise<string> {
  const id = `a${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  for (const st of PATH) {
    await sessions.transition(id, st as never);
    if (st === target) return id;
  }
  return id;
}
// GATE_C_STALLED 走支线（GATE_C_LOOP → GATE_C_STALLED）
async function mkStalled(): Promise<string> {
  const id = `a${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  for (const st of ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE', 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'GATE_C_STALLED']) {
    await sessions.transition(id, st as never);
  }
  return id;
}

// 清表隔离：DB 跨 test 共享，且 mock 动作不真推进状态 → 不清会让授权点 session 累积污染后续断言。
beforeEach(() => {
  db().exec('DELETE FROM session; DELETE FROM event_log;');
  calls = []; actionOk = true; autonomyLevel = 0; autonomyActor = 'M';
});

test('L0（默认）：4 个授权点都停着也零动作、零审计事件（零行为变更）', async () => {
  const ids = await Promise.all(['CONFIRMED', 'AWAITING_GO', 'DONE', 'AWAITING_GATE_D'].map(mkAt));
  await worker.applyAutonomy();
  assert.deepEqual(calls, []);
  for (const id of ids) assert.ok(!(await sessions.events(id)).some((e) => e.kind === 'autonomy_auto_triggered'));
});

test('L2：触发 requestGateB(CONFIRMED)+go(AWAITING_GO)，不触发更高级的 requestGateC/requestReviewPr', async () => {
  autonomyLevel = 2;
  const cId = await mkAt('CONFIRMED');
  await mkAt('AWAITING_GO');
  await mkAt('DONE');
  await mkAt('AWAITING_GATE_D');
  await worker.applyAutonomy();
  assert.deepEqual(calls.map((c) => c.fn).sort(), ['go', 'requestGateB']); // 恰 L≤2 的两个
  assert.ok((await sessions.events(cId)).some((e) => e.kind === 'autonomy_auto_triggered')); // 落审计
});

test('L4：4 个授权点全触发各自动作', async () => {
  autonomyLevel = 4;
  await mkAt('CONFIRMED');
  await mkAt('AWAITING_GO');
  await mkAt('DONE');
  await mkAt('AWAITING_GATE_D');
  await worker.applyAutonomy();
  assert.deepEqual(calls.map((c) => c.fn).sort(), ['go', 'requestGateB', 'requestGateC', 'requestReviewPr']);
});

test('红线：AWAITING_HUMAN_MERGE + GATE_C_STALLED 即便 L4 也永不被自动触发', async () => {
  autonomyLevel = 4;
  const mergeId = await mkAt('AWAITING_HUMAN_MERGE');
  const stalledId = await mkStalled();
  await worker.applyAutonomy();
  assert.deepEqual(calls, [], '红线态不在授权点集合 → applyAutonomy 根本不碰');
  assert.ok(!(await sessions.events(mergeId)).some((e) => e.kind === 'autonomy_auto_triggered'));
  assert.ok(!(await sessions.events(stalledId)).some((e) => e.kind === 'autonomy_auto_triggered'));
});

test('动作 !ok（权限/lint 未过）：先落「已尝试」审计、结果记 !ok、留人工（Blocker 修复：审计先于副作用）', async () => {
  autonomyLevel = 1;
  actionOk = false;
  const id = await mkAt('CONFIRMED');
  await worker.applyAutonomy();
  assert.equal(calls.length, 1, '尝试调了'); // 调用发生
  const evs = await sessions.events(id);
  assert.ok(evs.some((e) => e.kind === 'autonomy_auto_triggered'), '先落已尝试审计（即便动作后续失败也有痕）');
  const res = evs.find((e) => e.kind === 'autonomy_auto_result');
  assert.equal(JSON.parse(res!.detail ?? '{}').ok, false, '结果事件记 !ok');
});

test('去抖（SF1）：!ok 留停泊 → 同一态再 tick 不重试、不再刷事件', async () => {
  autonomyLevel = 1;
  actionOk = false;
  const id = await mkAt('CONFIRMED');
  await worker.applyAutonomy();
  await worker.applyAutonomy(); // 第二轮：session 未变（mock 动作不 transition、appendEvent 不 bump updated_at）→ 去抖跳过
  assert.equal(calls.length, 1, '只尝试一次，第二轮被去抖跳过');
  assert.equal((await sessions.events(id)).filter((e) => e.kind === 'autonomy_auto_triggered').length, 1, '尝试审计只一条');
});

test('署名 actor：自动动作用配置的 actor 调，审计事件记 by=actor', async () => {
  autonomyLevel = 1;
  autonomyActor = 'EO';
  const id = await mkAt('CONFIRMED');
  await worker.applyAutonomy();
  assert.equal(calls[0].by, 'EO');
  const ev = (await sessions.events(id)).find((e) => e.kind === 'autonomy_auto_triggered');
  assert.equal(JSON.parse(ev!.detail ?? '{}').by, 'EO'); // 审计 detail 记 by=actor

});
