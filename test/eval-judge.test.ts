// The pure logic of the acceptance LLM judge (runs in CI, costs nothing): schema parsing, and turning the
// judge's result into checks.
// The real judge call (judgeAcceptance) costs money and is only exercised end to end, mocked, in
// eval-production-flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcceptanceJudgeSchema, acceptanceJudgeChecks, type JudgeExpect } from '../src/eval/judge.ts';

test('AcceptanceJudgeSchema: a missing field takes its default, and strict rejects an unknown key', () => {
  const j = AcceptanceJudgeSchema.parse({ coverage: 80, testability: 70, declarative: true, verdict: 'good' });
  assert.equal(j.issues.length, 0); // defaults to empty
  assert.equal(AcceptanceJudgeSchema.parse({}).verdict, 'weak'); // defaults to weak (conservative)
  assert.throws(() => AcceptanceJudgeSchema.parse({ coverage: 1, bogus: true }));
});

test('acceptanceJudgeChecks: the coverage, testability and declarative thresholds, plus the metrics', () => {
  const good = AcceptanceJudgeSchema.parse({ coverage: 80, testability: 75, declarative: true, issues: [], verdict: 'good' });
  const x: JudgeExpect = { min_coverage: 60, min_testability: 60, require_declarative: true };
  const r = acceptanceJudgeChecks(good, x);
  assert.equal(r.checks.length, 3);
  assert.equal(r.checks.every((c) => c.pass), true);
  assert.deepEqual(r.metrics, { acceptance_coverage: 80, acceptance_testability: 75 });

  // A weak judge: low coverage plus imperative steps -> the matching checks fail, with the problems carried
  // into the detail.
  const weak = AcceptanceJudgeSchema.parse({ coverage: 40, testability: 50, declarative: false, issues: ['the refund path is missing', 'the scenario is a list of button clicks'], verdict: 'weak' });
  const r2 = acceptanceJudgeChecks(weak, x);
  assert.equal(r2.checks.find((c) => c.name.includes('coverage'))?.pass, false);
  assert.match(r2.checks.find((c) => c.name.includes('coverage'))!.detail, /the refund path is missing/);
  assert.equal(r2.checks.find((c) => c.name.includes('testability'))?.pass, false);
  assert.equal(r2.checks.find((c) => c.name.includes('declarative'))?.pass, false);

  // Only some thresholds set -> only the matching checks are produced
  assert.equal(acceptanceJudgeChecks(good, { min_coverage: 60 }).checks.length, 1);
  assert.equal(acceptanceJudgeChecks(good, {}).checks.length, 0);
});
