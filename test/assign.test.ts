// 单元：自动指派推荐算法（least-loaded + WIP limit，纯函数）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommend, wipLimitOf, inPool, type LoadRow } from '../src/util/assign.ts';

// 测试用配置：M 上限 2（带队容量小），其余 default 3。
const cfg = { pool: ['M', 'EO', 'CC', 'DE'], wip_limit: { default: 3, M: 2 }, in_progress_statuses: [4, 5, 6] };

const L = (code: string, wip: number, loadPoints: number): LoadRow => ({ code, wip, loadPoints });

test('wipLimitOf：覆盖优先、缺省兜底', () => {
  assert.equal(wipLimitOf(cfg, 'M'), 2);
  assert.equal(wipLimitOf(cfg, 'EO'), 3);
});

test('inPool：大小写不敏感归一；不在池→null', () => {
  assert.equal(inPool(cfg, 'de'), 'DE');
  assert.equal(inPool(cfg, ' m '), 'M');
  assert.equal(inPool(cfg, 'BD'), null);
});

test('选投影负载最低者', () => {
  const r = recommend('M', [L('M', 0, 8), L('EO', 0, 3), L('CC', 0, 0), L('DE', 0, 20)], cfg);
  assert.equal(r.pick, 'CC'); // 0 + 3 = 3 最低
  assert.equal(r.points, 3);
  assert.equal(r.allOverWip, false);
});

test('WIP 超上限者被排除，即便其负载最低', () => {
  const r = recommend('S', [L('M', 0, 8), L('EO', 0, 3), L('CC', 3, 0), L('DE', 0, 20)], cfg);
  assert.equal(r.pick, 'EO'); // CC 负载 0 但在研 3≥上限 3 → 出局；EO 3+1=4 次低
  const lx = r.table.find((x) => x.code === 'CC')!;
  assert.equal(lx.eligible, false);
  assert.equal(r.allOverWip, false);
});

test('全员超 WIP → 回退全池择优并标注', () => {
  const r = recommend('M', [L('M', 2, 5), L('EO', 3, 1), L('CC', 3, 0), L('DE', 3, 10)], cfg);
  assert.equal(r.allOverWip, true);
  assert.equal(r.pick, 'CC'); // 回退全池后仍取投影最低 0+3
});

test('平手：投影相等 → 在研条数少者优先', () => {
  // M/DE 负载抬高出局候选；EO 与 CC 投影都 8，CC 在研更少。
  const r = recommend('M', [L('M', 0, 100), L('EO', 2, 5), L('CC', 1, 5), L('DE', 0, 100)], cfg);
  assert.equal(r.pick, 'CC');
});

test('规模点数反映在 points / 投影上', () => {
  assert.equal(recommend('XL', [], cfg).points, 20);
  assert.equal(recommend(null, [], cfg).points, 0);
});

test('探测失败(ok=false)的成员不参与自动选——负载未知绝不当 0 抢指派', () => {
  // EO 探测失败：即便看起来 0 负载也不能选；应在「已知负载」者里择优。
  const r = recommend(
    'M',
    [
      { code: 'M', wip: 0, loadPoints: 8, ok: true },
      { code: 'EO', wip: 0, loadPoints: 0, ok: false }, // 探测失败 → 排除
      { code: 'CC', wip: 0, loadPoints: 3, ok: true },
      { code: 'DE', wip: 0, loadPoints: 20, ok: true },
    ],
    cfg,
  );
  assert.equal(r.pick, 'CC'); // 已知者里投影最低；EO 未知被排除
  assert.equal(r.probeIncomplete, true);
});

test('缺行的池成员视为未知(ok:false)，不被推荐', () => {
  // 仅 M 有数据；EO/CC/DE 缺行 → 默认 ok:false 未知 → 不参与自动选，只剩 M。
  const r = recommend('M', [{ code: 'M', wip: 1, loadPoints: 5, ok: true }], cfg);
  assert.equal(r.pick, 'M');
  assert.equal(r.probeIncomplete, true);
  assert.equal(r.table.length, 4); // 表仍展开全池（展示用）
});

test('全员探测失败/未知 → pick=null（强制人工指派）', () => {
  const r = recommend(
    'M',
    [
      { code: 'M', wip: 0, loadPoints: 0, ok: false },
      { code: 'EO', wip: 0, loadPoints: 0, ok: false },
    ],
    cfg,
  );
  assert.equal(r.pick, null);
  assert.equal(r.probeIncomplete, true);
});
