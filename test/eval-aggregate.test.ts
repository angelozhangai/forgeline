// Regression on the pure logic of eval's multi-sample aggregation, report, trend and persistence (runs in
// CI, costs nothing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FixtureResult } from '../src/eval/expectations.ts';
import { aggregateFixture, summarize, formatReport, diffRuns, formatTrend, } from '../src/eval/aggregate.ts';
import { saveEvalRun, loadLatestEvalRun } from '../src/eval/store.ts';

const sample = (over: Partial<FixtureResult> = {}): FixtureResult => ({ name: 'f', desc: 'd', schemaValid: true, checks: [{ name: 'c', pass: true, detail: '' }], costUsd: 0.1, ...over });

test('aggregateFixture: it only passes if every run passed; cost is summed; jitter collects each run\'s metrics', () => {
  const a = aggregateFixture('f', 'd', [sample({ metrics: { open_questions: 1 } }), sample({ metrics: { open_questions: 3 } })]);
  assert.equal(a.pass, true);
  assert.equal(a.passedRuns, 2);
  assert.equal(Math.round(a.costUsd * 100) / 100, 0.2);
  assert.deepEqual(a.jitter.open_questions, [1, 3]);

  // One failing run -> the whole line fails (a golden case should be stable), and error takes the first failure
  const b = aggregateFixture('f', 'd', [sample(), sample({ checks: [{ name: 'c', pass: false, detail: 'out of range' }] }), sample({ schemaValid: false, error: 'the shape degraded' })]);
  assert.equal(b.pass, false);
  assert.equal(b.passedRuns, 1);
  assert.equal(b.error, 'the shape degraded');

  // No samples -> it does not count as passing
  assert.equal(aggregateFixture('f', 'd', []).pass, false);
});

test('summarize/formatReport: a single run (runs=1) and several (runs>1 shows the jitter)', () => {
  const aggOk = aggregateFixture('a', 'the first', [sample({ name: 'a', metrics: { open_questions: 2 } })]);
  const aggBad = aggregateFixture('b', 'the second', [sample({ name: 'b', schemaValid: false, error: 'the output does not match the gate contract: ...', checks: [] })]);
  const rep1 = summarize([aggOk, aggBad], 1);
  assert.equal(rep1.allPass, false);
  const t1 = formatReport(rep1);
  assert.match(t1, /❌ a regression/);
  assert.match(t1, /1\/2 fixtures passed/);
  assert.match(t1, /does not match the gate contract/);

  // Several samples: the pass rate plus the jitter line
  const aggMulti = aggregateFixture('a', 'the first', [sample({ name: 'a', metrics: { open_questions: 4 } }), sample({ name: 'a', metrics: { open_questions: 1 } })]);
  const rep2 = summarize([aggMulti], 3);
  const t2 = formatReport(rep2);
  assert.match(t2, /\[2\/2 runs passed\]/);
  assert.match(t2, /open_questions per run: \[4, 1\]/);
  assert.match(t2, /each run 3 times/);

  // P3: red on the first run and green on the second -> the whole line is red, and the report must show the
  // **first failing sample's** failed check, not the last one that happened to be green.
  const flaky = aggregateFixture('a', 'the first', [
    sample({ name: 'a', checks: [{ name: 'open_questions <= 3', pass: false, detail: 'actual 5' }] }),
    sample({ name: 'a', checks: [{ name: 'open_questions <= 3', pass: true, detail: 'actual 2' }] }),
  ]);
  assert.equal(flaky.pass, false);
  const t3 = formatReport(summarize([flaky], 2));
  assert.match(t3, /✖ open_questions <= 3 \(actual 5\)/); // it showed the red run, not the green last one
});

test('diffRuns/formatTrend: green to red / red to green / new / a metric moving', () => {
  const prev = summarize([aggregateFixture('a', '', [sample({ name: 'a', metrics: { open_questions: 4 } })]), aggregateFixture('b', '', [sample({ name: 'b', schemaValid: false, error: 'x', checks: [] })])], 1);
  const cur = summarize(
    [
      aggregateFixture('a', '', [sample({ name: 'a', checks: [{ name: 'c', pass: false, detail: '' }], metrics: { open_questions: 1 } })]), // a: green -> red, the metric 4 -> 1
      aggregateFixture('b', '', [sample({ name: 'b', metrics: { open_questions: 0 } })]), // b: red -> green
      aggregateFixture('c', '', [sample({ name: 'c' })]), // c: new
    ],
    1,
  );
  const trend = diffRuns(prev, cur);
  const a = trend.find((t) => t.name === 'a')!;
  assert.deepEqual([a.was, a.now], [true, false]);
  assert.deepEqual(a.metricDelta.open_questions, { from: 4, to: 1 });
  assert.deepEqual([trend.find((t) => t.name === 'b')!.was, trend.find((t) => t.name === 'b')!.now], [false, true]);
  assert.equal(trend.find((t) => t.name === 'c')!.was, null);

  const txt = formatTrend(trend);
  assert.match(txt, /⚠️ green -> red \(a regression\) a \(open_questions 4->1\)/);
  assert.match(txt, /✅ red -> green \(fixed\) b/);
  assert.match(txt, /🆕 new c/);

  // No history -> everything is new
  assert.equal(diffRuns(null, cur).every((t) => t.was === null), true);
});

test('store: saveEvalRun / loadLatestEvalRun round-trip (the latest by stamp)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-eval-store-'));
  assert.equal(loadLatestEvalRun(dir), null); // empty -> null
  const rep1 = summarize([aggregateFixture('a', '', [sample({ name: 'a' })])], 1);
  const rep2 = summarize([aggregateFixture('a', '', [sample({ name: 'a', schemaValid: false, error: 'x', checks: [] })])], 1);
  saveEvalRun(rep1, '2026-06-18T01-00-00', dir);
  saveEvalRun(rep2, '2026-06-18T02-00-00', dir); // later
  const latest = loadLatestEvalRun(dir);
  assert.equal(latest?.allPass, false); // it picked up rep2 (the later stamp)
  assert.equal(latest?.fixtures[0].name, 'a');
});
