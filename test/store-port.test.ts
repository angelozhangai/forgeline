// 单测：SessionStore 接缝（store/port.ts 接口 + store/index.ts 选择点 + localSqlite adapter）。
// 守两条：① 选择点 `store` 就是 localSqlite 自由函数的 bundle（引用相等 → 零行为漂移），
//            **例外只有 WRAPPED 里明确列名的那几个**（扩展钩子装饰器）；
//         ② 经 `store.*` 走真实 sqlite 的 create/get/patch/transition/event 全链与直调一致。
// 必须在导入前设 FORGE_DB（真 node:sqlite，:memory: 隔离）。
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sessions = await import('../src/store/sessions.ts');
const { store } = await import('../src/store/index.ts');

// 接缝上每个公开操作。漏一个 → 消费方迁移到 store.* 时才暴雷。
const SEAM_METHODS = [
  'create', 'findByIssueRef', 'isDuplicateDocRefError', 'isDuplicateIssueRefError',
  'get', 'getBySlug', 'findByPrdUrl', 'findByDocRef', 'resolve',
  'listByStates', 'listAll', 'distinctProjects', 'countByState', 'countByStates',
  'patch', 'transition', 'appendEvent', 'events', 'lastEventTs', 'leaseClaim',
] as const;

// 选择点上被装饰器包过一层的方法。**这是一张白名单，不是豁免**：
// transition 被 withTransitionHook 包了（扩展生命周期钩子，见 src/store/index.ts）。
// 谁再悄悄包第二个方法而不更新这张表，下面那条断言当场红——比原来「全都必须引用相等」更严，
// 因为它同时守住了「不该被包的方法一个都没被包」。
const WRAPPED = new Set<string>(['transition']);

// ① 选择点 = localSqlite 自由函数 bundle（+ 明确列名的装饰器）。
test('store 选择点：未列名的方法一律与 sessions 自由函数引用相等（零漂移）', () => {
  for (const m of SEAM_METHODS) {
    const free = (sessions as unknown as Record<string, unknown>)[m];
    if (typeof free !== 'function') continue; // 该操作不是自由函数导出，跳过引用比对
    if (WRAPPED.has(m)) {
      assert.notEqual(store[m], free, `${m} 在 WRAPPED 名单里却没被包——名单过期了`);
    } else {
      assert.equal(store[m], free, `${m} 被悄悄换成了另一份实现（会漂移）；确属有意包装请加进 WRAPPED 并写清理由`);
    }
  }
});

test('store 选择点：装饰器不得增删接缝上的方法', () => {
  // `...inner` 展开只复制自有可枚举属性：将来 adapter 改用 class / 原型方法就会在这里丢方法，
  // 而症状是运行时 "store.xxx is not a function"，离改动点很远。这条把它挡在提交前。
  assert.deepEqual(
    Object.keys(store).sort(),
    Object.keys(sessions.localSqliteStore).sort(),
    '选择点的方法集合必须与 adapter 完全一致',
  );
});

test('store 接缝面完整：覆盖 sessions 全部公开 store 操作', () => {
  for (const m of SEAM_METHODS) {
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
