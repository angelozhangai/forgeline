// Unit: the requirement-complexity model. ⚠️ It must agree with the main repo's load-eval.md and
// sync-labels: 4 tiers S/M/L/XL, worth S1/M3/L8/XL20.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIZES, POINTS, sizePoints, normSize, sizeMeter, sizeBadge } from '../src/util/sizing.ts';

test('the tiers and their points: 4 tiers, S1/M3/L8/XL20 (aligned with the main repo weekly-load)', () => {
  assert.deepEqual([...SIZES], ['S', 'M', 'L', 'XL']);
  assert.deepEqual([POINTS.S, POINTS.M, POINTS.L, POINTS.XL], [1, 3, 8, 20]);
});

test('normSize: case-insensitive; anything invalid, XS included, -> null', () => {
  assert.equal(normSize('l'), 'L');
  assert.equal(normSize(' xl '), 'XL');
  assert.equal(normSize('XS'), null); // there is no XS among the 4 tiers
  assert.equal(normSize('huge'), null);
});

test('sizePoints: null -> 0', () => {
  assert.equal(sizePoints('L'), 8);
  assert.equal(sizePoints(null), 0);
});

test('sizeMeter: `tier` of the 4 cells lit (S=1 … XL=4)', () => {
  assert.equal(sizeMeter('S'), '●○○○');
  assert.equal(sizeMeter('L'), '●●●○');
  assert.equal(sizeMeter('XL'), '●●●●');
});

test('sizeBadge: carries the tier, the points and the meter; null -> TBD', () => {
  assert.match(sizeBadge('L'), /Complexity L · 8pt ●●●○/);
  assert.match(sizeBadge(null), /TBD/);
});
