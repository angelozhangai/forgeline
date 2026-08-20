// 单元：需求复杂度模型。⚠️ 必须与主仓 load-eval.md / sync-labels 一致：4 档 S/M/L/XL，分值 S1/M3/L8/XL20。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIZES, POINTS, sizePoints, normSize, sizeMeter, sizeBadge } from '../src/util/sizing.ts';

test('档位与分值：4 档，S1/M3/L8/XL20（对齐主仓 weekly-load）', () => {
  assert.deepEqual([...SIZES], ['S', 'M', 'L', 'XL']);
  assert.deepEqual([POINTS.S, POINTS.M, POINTS.L, POINTS.XL], [1, 3, 8, 20]);
});

test('normSize：大小写不敏感；非法/XS→null', () => {
  assert.equal(normSize('l'), 'L');
  assert.equal(normSize(' xl '), 'XL');
  assert.equal(normSize('XS'), null); // 4 档无 XS
  assert.equal(normSize('huge'), null);
});

test('sizePoints：null→0', () => {
  assert.equal(sizePoints('L'), 8);
  assert.equal(sizePoints(null), 0);
});

test('sizeMeter：4 格点亮 tier（S=1…XL=4）', () => {
  assert.equal(sizeMeter('S'), '●○○○');
  assert.equal(sizeMeter('L'), '●●●○');
  assert.equal(sizeMeter('XL'), '●●●●');
});

test('sizeBadge：含档/分/点阵；null→待定', () => {
  assert.match(sizeBadge('L'), /复杂度 L · 8pt ●●●○/);
  assert.match(sizeBadge(null), /待定/);
});
