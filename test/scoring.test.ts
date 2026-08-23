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

test('normScore: clamped to 0-100 and rounded (a dirty value never reaches the database)', () => {
  assert.equal(normScore(72.6), 73);
  assert.equal(normScore(-5), 0);
  assert.equal(normScore(140), SCORE_MAX);
  assert.equal(normScore('abc'), 0); // not a number -> 0
});

test('normDims: each dimension clamped to 0-25 and rounded, a missing one filled with 0', () => {
  const d = normDims({ clarity: 30, completeness: 18.4 });
  assert.equal(d.clarity, 25); // pulled back inside the range
  assert.equal(d.completeness, 18);
  assert.equal(d.feasibility, 0); // missing -> 0
  assert.equal(d.testability, 0);
  assert.deepEqual(normDims(null), { clarity: 0, completeness: 0, feasibility: 0, testability: 0 });
});

test('scoreBand: 85+ excellent / 70+ good / 55+ fair / the rest poor', () => {
  assert.equal(scoreBand(90), 'excellent');
  assert.equal(scoreBand(72), 'good');
  assert.equal(scoreBand(60), 'fair');
  assert.equal(scoreBand(40), 'poor');
});

test('scoreBadge: null -> not yet rated; with a score -> the band and the dimensions', () => {
  assert.match(scoreBadge(null), /not yet rated/);
  const b = scoreBadge(72, { clarity: 18, completeness: 15, feasibility: 22, testability: 17 });
  assert.match(b, /72\/100/);
  assert.match(b, /good/);
  assert.match(b, /clarity 18/);
});

test('SCORE_RUBRIC: covers all four dimension keys (aligned with the envelope)', () => {
  for (const d of SCORE_DIMS) assert.ok(SCORE_RUBRIC.includes(d), `dimension ${d} is missing`);
});
