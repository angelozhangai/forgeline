// 单测：SessionStore 接缝（store/port.ts 接口 + store/index.ts 选择点 + localSqlite adapter）。
// 守两条：① 选择点 `store` 就是 localSqlite 自由函数的 bundle（引用相等 → 零行为漂移）；
//         ② 经 `store.*` 走真实 sqlite 的 create/get/patch/transition/event 全链与直调一致。
// 必须在导入前设 FORGE_DB（真 node:sqlite，:memory: 隔离）。
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sessions = await import('../src/store/sessions.ts');
const { store } = await import('../src/store/index.ts');

// ① 选择点 = localSqlite 自由函数 bundle：方法引用相等（绝非另写一份会漂移的实现）。
test('store 选择点：方法即 sessions 自由函数（引用相等，零漂移）', () => {
  assert.equal(store.get, sessions.get);
  assert.equal(store.create, sessions.create);
  assert.equal(store.patch, sessions.patch);
  assert.equal(store.transition, sessions.transition);
  assert.equal(store.appendEvent, sessions.appendEvent);
  assert.equal(store.leaseClaim, sessions.leaseClaim);
  assert.equal(store, sessions.localSqliteStore);
});

// 接口面完整性：消费方迁移到 store.* 前，确认每个公开 store 操作都在接缝上（漏一个 → 迁移时才暴雷）。
test('store 接缝面完整：覆盖 sessions 全部公开 store 操作', () => {
  for (const m of [
    'create', 'findByIssueRef', 'isDuplicateTokenError', 'isDuplicateIssueRefError',
    'get', 'getBySlug', 'findByPrdUrl', 'findByDocToken', 'resolve',
    'listByStates', 'listAll', 'distinctProjects', 'countByState', 'countByStates',
    'patch', 'transition', 'appendEvent', 'events', 'lastEventTs', 'leaseClaim',
  ] as const) {
    assert.equal(typeof store[m], 'function', `store.${m} 缺失`);
  }
});

// ② 经 store.* 的真实 sqlite 全链（与直调 sessions.* 同库、同行为）。
test('store.create → get/patch/transition/event 全链（真 sqlite）', async () => {
  const s = await store.create({ id: 'p1', slug: 'p1', title: 'T', branch: 'dev', prd_url: 'https://x.feishu.cn/wiki/p1' });
  assert.equal(s.state, 'INTAKE');
  assert.equal((await store.get('p1'))!.slug, 'p1');

  await store.patch('p1', { title: 'T2' });
  assert.equal((await store.get('p1'))!.title, 'T2');

  await store.transition('p1', 'GATE_A_RUNNING');
  assert.equal((await store.get('p1'))!.state, 'GATE_A_RUNNING');
  await assert.rejects(() => store.transition('p1', 'DONE'), /illegal transition/);

  await store.appendEvent('p1', 'note', { k: 1 });
  const kinds = (await store.events('p1')).map((e) => e.kind);
  assert.ok(kinds.includes('intake') && kinds.includes('transition') && kinds.includes('note'));
});

// store 与直调 sessions 同一库：一边写、另一边读得到（证明非两套状态）。
test('store 与 sessions 自由函数共享同一库（同库视图）', async () => {
  await sessions.create({ id: 'p2', slug: 'p2', title: 'T', branch: 'dev', prd_url: 'https://x.feishu.cn/wiki/p2' });
  assert.equal((await store.get('p2'))!.id, 'p2');
  await store.patch('p2', { size: 'L' });
  assert.equal((await sessions.get('p2'))!.size, 'L');
});
