import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normScore,
  normDims,
  scoreBand,
  scoreBadge,
  SCORE_RUBRIC,
  SCORE_DIMS,
  SCORE_MAX,
} from '../src/util/scoring.ts';

test('normScore：clamp 0-100 + 取整（脏值绝不落库）', () => {
  assert.equal(normScore(72.6), 73);
  assert.equal(normScore(-5), 0);
  assert.equal(normScore(140), SCORE_MAX);
  assert.equal(normScore('abc'), 0); // 非数 → 0
});

test('normDims：每维 clamp 0-25 + 取整，缺维补 0', () => {
  const d = normDims({ clarity: 30, completeness: 18.4 });
  assert.equal(d.clarity, 25); // 越界收口
  assert.equal(d.completeness, 18);
  assert.equal(d.feasibility, 0); // 缺维补 0
  assert.equal(d.testability, 0);
  assert.deepEqual(normDims(null), { clarity: 0, completeness: 0, feasibility: 0, testability: 0 });
});

test('scoreBand：85+优 / 70+良 / 55+中 / 其余差', () => {
  assert.equal(scoreBand(90), '优');
  assert.equal(scoreBand(72), '良');
  assert.equal(scoreBand(60), '中');
  assert.equal(scoreBand(40), '差');
});

test('scoreBadge：null → 待评；有分 → 带档与维度', () => {
  assert.match(scoreBadge(null), /待评/);
  const b = scoreBadge(72, { clarity: 18, completeness: 15, feasibility: 22, testability: 17 });
  assert.match(b, /72\/100/);
  assert.match(b, /良/);
  assert.match(b, /清晰度18/);
});

test('SCORE_RUBRIC：覆盖四个维度键名（与 envelope 对齐）', () => {
  for (const d of SCORE_DIMS) assert.ok(SCORE_RUBRIC.includes(d), `缺维度 ${d}`);
});
