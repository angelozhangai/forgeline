// 单元：群补拉游标的水位语义（单调前进、种子幂等）。这是「离线不漏需求」的正确性核心。
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const cursors = await import('../src/store/cursors.ts');

test('seedCursor：仅在缺失时种子化，不覆盖已有水位', () => {
  cursors.seedCursor('oc_a', 1000);
  assert.equal(cursors.getCursor('oc_a'), 1000);
  cursors.seedCursor('oc_a', 5000); // 已存在 → 不覆盖（否则每次开机种子=now 会冲掉真实水位 → 漏消息）
  assert.equal(cursors.getCursor('oc_a'), 1000);
});

test('advanceCursor：只前进不后退（防乱序消息回退水位导致重复/漏）', () => {
  cursors.advanceCursor('oc_b', 2000);
  assert.equal(cursors.getCursor('oc_b'), 2000);
  cursors.advanceCursor('oc_b', 1500); // 更小 → 不动
  assert.equal(cursors.getCursor('oc_b'), 2000);
  cursors.advanceCursor('oc_b', 3000); // 更大 → 前进
  assert.equal(cursors.getCursor('oc_b'), 3000);
});

test('advanceCursor 对未知群 = 首次登记；getCursor 未知群 → null', () => {
  assert.equal(cursors.getCursor('oc_new'), null);
  cursors.advanceCursor('oc_new', 42);
  assert.equal(cursors.getCursor('oc_new'), 42);
});

test('allChats：列出所有已登记群（backfill 遍历对象）', () => {
  cursors.seedCursor('oc_x', 1);
  cursors.advanceCursor('oc_y', 1);
  const all = cursors.allChats();
  assert.ok(all.includes('oc_x') && all.includes('oc_y'));
});
