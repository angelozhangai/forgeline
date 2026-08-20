// eval 多样本聚合 / 报告 / 趋势 / 落盘的纯逻辑回归（进 ci，不花钱）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FixtureResult } from '../src/eval/expectations.ts';
import { aggregateFixture, summarize, formatReport, diffRuns, formatTrend, } from '../src/eval/aggregate.ts';
import { saveEvalRun, loadLatestEvalRun } from '../src/eval/store.ts';

const sample = (over: Partial<FixtureResult> = {}): FixtureResult => ({ name: 'f', desc: 'd', schemaValid: true, checks: [{ name: 'c', pass: true, detail: '' }], costUsd: 0.1, ...over });

test('aggregateFixture：全过才算过；成本累加；jitter 收集各次指标', () => {
  const a = aggregateFixture('f', 'd', [sample({ metrics: { open_questions: 1 } }), sample({ metrics: { open_questions: 3 } })]);
  assert.equal(a.pass, true);
  assert.equal(a.passedRuns, 2);
  assert.equal(Math.round(a.costUsd * 100) / 100, 0.2);
  assert.deepEqual(a.jitter.open_questions, [1, 3]);

  // 有一次失败 → 整条不过（golden 该稳），error 取首个失败
  const b = aggregateFixture('f', 'd', [sample(), sample({ checks: [{ name: 'c', pass: false, detail: '越界' }] }), sample({ schemaValid: false, error: '形状退化' })]);
  assert.equal(b.pass, false);
  assert.equal(b.passedRuns, 1);
  assert.equal(b.error, '形状退化');

  // 空样本 → 不算过
  assert.equal(aggregateFixture('f', 'd', []).pass, false);
});

test('summarize/formatReport：单次（runs=1）与多次（runs>1 展示抖动）', () => {
  const aggOk = aggregateFixture('a', '甲', [sample({ name: 'a', metrics: { open_questions: 2 } })]);
  const aggBad = aggregateFixture('b', '乙', [sample({ name: 'b', schemaValid: false, error: '产出不符合闸合约：…', checks: [] })]);
  const rep1 = summarize([aggOk, aggBad], 1);
  assert.equal(rep1.allPass, false);
  const t1 = formatReport(rep1);
  assert.match(t1, /❌ 有回归/);
  assert.match(t1, /1\/2 fixtures 通过/);
  assert.match(t1, /产出不符合闸合约/);

  // 多样本：通过率 + 抖动行
  const aggMulti = aggregateFixture('a', '甲', [sample({ name: 'a', metrics: { open_questions: 4 } }), sample({ name: 'a', metrics: { open_questions: 1 } })]);
  const rep2 = summarize([aggMulti], 3);
  const t2 = formatReport(rep2);
  assert.match(t2, /\[2\/2 次通过\]/);
  assert.match(t2, /open_questions 各次：\[4, 1\]/);
  assert.match(t2, /每条跑 3 次/);

  // P3：第1次红、第2次绿 → 整条红，报告须展示**首个失败样本**的失败 check（而非恰好绿的末次）
  const flaky = aggregateFixture('a', '甲', [
    sample({ name: 'a', checks: [{ name: 'open_questions≤3', pass: false, detail: '实际 5' }] }),
    sample({ name: 'a', checks: [{ name: 'open_questions≤3', pass: true, detail: '实际 2' }] }),
  ]);
  assert.equal(flaky.pass, false);
  const t3 = formatReport(summarize([flaky], 2));
  assert.match(t3, /✖ open_questions≤3（实际 5）/); // 展示了红的那次，不是绿的末次
});

test('diffRuns/formatTrend：绿→红 / 红→绿 / 新增 / 指标变化', () => {
  const prev = summarize([aggregateFixture('a', '', [sample({ name: 'a', metrics: { open_questions: 4 } })]), aggregateFixture('b', '', [sample({ name: 'b', schemaValid: false, error: 'x', checks: [] })])], 1);
  const cur = summarize(
    [
      aggregateFixture('a', '', [sample({ name: 'a', checks: [{ name: 'c', pass: false, detail: '' }], metrics: { open_questions: 1 } })]), // a: 绿→红，指标 4→1
      aggregateFixture('b', '', [sample({ name: 'b', metrics: { open_questions: 0 } })]), // b: 红→绿
      aggregateFixture('c', '', [sample({ name: 'c' })]), // c: 新增
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
  assert.match(txt, /⚠️ 绿→红（回归） a（open_questions 4→1）/);
  assert.match(txt, /✅ 红→绿（修复） b/);
  assert.match(txt, /🆕 新增 c/);

  // 无历史 → 全部新增
  assert.equal(diffRuns(null, cur).every((t) => t.was === null), true);
});

test('store：saveEvalRun / loadLatestEvalRun round-trip（按 stamp 取最近）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-eval-store-'));
  assert.equal(loadLatestEvalRun(dir), null); // 空 → null
  const rep1 = summarize([aggregateFixture('a', '', [sample({ name: 'a' })])], 1);
  const rep2 = summarize([aggregateFixture('a', '', [sample({ name: 'a', schemaValid: false, error: 'x', checks: [] })])], 1);
  saveEvalRun(rep1, '2026-06-18T01-00-00', dir);
  saveEvalRun(rep2, '2026-06-18T02-00-00', dir); // 更晚
  const latest = loadLatestEvalRun(dir);
  assert.equal(latest?.allPass, false); // 取到 rep2（更晚的 stamp）
  assert.equal(latest?.fixtures[0].name, 'a');
});
