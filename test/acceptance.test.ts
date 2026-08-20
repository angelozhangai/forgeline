import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceMarkdown, lintAcceptance } from '../src/util/acceptance.ts';
import { GateBSchema } from '../src/gates/envelopes.ts';
import type { Acceptance } from '../src/gates/envelopes.ts';

test('acceptanceMarkdown：空 / undefined → 空串', () => {
  assert.equal(acceptanceMarkdown(undefined), '');
  assert.equal(acceptanceMarkdown({ contracts: [], scenarios: [] }), '');
  // 全是空白项也算空
  assert.equal(
    acceptanceMarkdown({ contracts: [{ repo: 'C', surface: '  ' }], scenarios: [{ id: 'AC1', repo: 'C', gherkin: '' }] }),
    '',
  );
});

const acc: Acceptance = {
  contracts: [
    { repo: 'C', surface: 'POST /api/v1/pay/refund → 200|409' },
    { repo: '', surface: '全局：所有金额以分为单位' },
  ],
  scenarios: [
    { id: 'AC1', repo: 'C', gherkin: 'Given 已支付订单\nWhen 退款\nThen refunded' },
    { id: 'AC2', repo: 'U', gherkin: 'Given 前端\nWhen 点退款\nThen 提示' },
  ],
};

test('acceptanceMarkdown：按 repo 过滤，含未标 repo 的通用项，排除他仓', () => {
  const md = acceptanceMarkdown(acc, 'C');
  assert.equal(md.includes('POST /api/v1/pay/refund'), true);
  assert.equal(md.includes('全局：所有金额以分为单位'), true); // 通用项纳入
  assert.equal(md.includes('AC1'), true);
  assert.equal(md.includes('AC2'), false); // U 仓场景不进 C 仓 issue
  assert.equal(md.includes('```gherkin'), true);
  assert.equal(md.includes('外环'), true);
});

test('acceptanceMarkdown：不指定 repo → 全取（Epic/技术方案文档用）', () => {
  const md = acceptanceMarkdown(acc);
  assert.equal(md.includes('AC1'), true);
  assert.equal(md.includes('AC2'), true);
});

// ---- 外环验收 lint（GO 前闸口）----
const good = GateBSchema.parse({
  acceptance: {
    contracts: [{ repo: 'C', surface: 'POST /api/v1/pay/refund → 200|409' }],
    scenarios: [{ id: 'AC1', repo: 'C', gherkin: 'Given 已支付订单\nWhen 以幂等键退款\nThen 返回 refund_id' }],
  },
  issue_specs: [{ repo: 'C', title: 'feat(pay): 退款' }],
});

test('lintAcceptance：合格外环 → ok', () => {
  const r = lintAcceptance(good);
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
});

test('lintAcceptance：空 acceptance → 缺场景 + 缺契约', () => {
  const r = lintAcceptance(GateBSchema.parse({ issue_specs: [{ repo: 'C', title: 't' }] }));
  assert.equal(r.ok, false);
  assert.equal(r.problems.some((p) => p.includes('缺场景')), true);
  assert.equal(r.problems.some((p) => p.includes('缺契约')), true);
});

test('lintAcceptance：命令式场景（点按钮）→ 挡', () => {
  const env = GateBSchema.parse({
    acceptance: {
      contracts: [{ repo: 'C', surface: 'POST /x' }],
      scenarios: [{ id: 'AC1', repo: 'C', gherkin: 'Given 页面\nWhen 点击提交按钮\nThen 成功' }],
    },
    issue_specs: [{ repo: 'C', title: 't' }],
  });
  const r = lintAcceptance(env);
  assert.equal(r.ok, false);
  assert.equal(r.problems.some((p) => p.includes('命令式')), true);
});

test('lintAcceptance：场景缺 Then → 结构不全', () => {
  const env = GateBSchema.parse({
    acceptance: {
      contracts: [{ repo: 'C', surface: 'POST /x' }],
      scenarios: [{ id: 'AC1', repo: 'C', gherkin: 'Given 订单\nWhen 退款' }],
    },
    issue_specs: [{ repo: 'C', title: 't' }],
  });
  assert.equal(lintAcceptance(env).problems.some((p) => p.includes('结构不全')), true);
});

test('lintAcceptance：仓有 issue 但无外环覆盖 → 挡；通用项可豁免', () => {
  const env = GateBSchema.parse({
    acceptance: {
      contracts: [{ repo: 'C', surface: 'POST /x' }],
      scenarios: [{ id: 'AC1', repo: 'C', gherkin: 'Given a\nWhen b\nThen c' }],
    },
    issue_specs: [{ repo: 'C', title: 't1' }, { repo: 'U', title: 't2' }], // U 无覆盖
  });
  assert.equal(lintAcceptance(env).problems.some((p) => p.includes('仓 U')), true);

  const env2 = GateBSchema.parse({
    acceptance: {
      contracts: [{ repo: '', surface: '通用约束' }], // 通用项覆盖全部仓
      scenarios: [{ id: 'AC1', repo: '', gherkin: 'Given a\nWhen b\nThen c' }],
    },
    issue_specs: [{ repo: 'C', title: 't1' }, { repo: 'U', title: 't2' }],
  });
  assert.equal(lintAcceptance(env2).ok, true);
});
