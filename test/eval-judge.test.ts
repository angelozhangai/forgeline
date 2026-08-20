// acceptance LLM-judge 的纯逻辑（进 ci，不花钱）：schema 解析 + judge 结果→check 转换。
// 真 judge 调用（judgeAcceptance）花钱，只在 eval-production-flow 用 mock 测端到端。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcceptanceJudgeSchema, acceptanceJudgeChecks, type JudgeExpect } from '../src/eval/judge.ts';

test('AcceptanceJudgeSchema：缺字段走默认，strict 挡未知键', () => {
  const j = AcceptanceJudgeSchema.parse({ coverage: 80, testability: 70, declarative: true, verdict: 'good' });
  assert.equal(j.issues.length, 0); // 默认空
  assert.equal(AcceptanceJudgeSchema.parse({}).verdict, 'weak'); // 默认 weak（保守）
  assert.throws(() => AcceptanceJudgeSchema.parse({ coverage: 1, bogus: true }));
});

test('acceptanceJudgeChecks：覆盖/可测/声明式门槛 + 指标', () => {
  const good = AcceptanceJudgeSchema.parse({ coverage: 80, testability: 75, declarative: true, issues: [], verdict: 'good' });
  const x: JudgeExpect = { min_coverage: 60, min_testability: 60, require_declarative: true };
  const r = acceptanceJudgeChecks(good, x);
  assert.equal(r.checks.length, 3);
  assert.equal(r.checks.every((c) => c.pass), true);
  assert.deepEqual(r.metrics, { acceptance_coverage: 80, acceptance_testability: 75 });

  // 弱 judge：覆盖低 + 命令式 → 对应 check 失败，问题带进 detail
  const weak = AcceptanceJudgeSchema.parse({ coverage: 40, testability: 50, declarative: false, issues: ['漏了退款路径', '场景是点按钮步骤'], verdict: 'weak' });
  const r2 = acceptanceJudgeChecks(weak, x);
  assert.equal(r2.checks.find((c) => c.name.includes('覆盖'))?.pass, false);
  assert.match(r2.checks.find((c) => c.name.includes('覆盖'))!.detail, /漏了退款路径/);
  assert.equal(r2.checks.find((c) => c.name.includes('可测性'))?.pass, false);
  assert.equal(r2.checks.find((c) => c.name.includes('声明式'))?.pass, false);

  // 只设部分门槛 → 只产对应 check
  assert.equal(acceptanceJudgeChecks(good, { min_coverage: 60 }).checks.length, 1);
  assert.equal(acceptanceJudgeChecks(good, {}).checks.length, 0);
});
