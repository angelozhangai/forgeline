// 集成（不花钱）：evalGateA 的真实裁判链路——mock runClaude 喂各种「产出」，
// 验证 eval 不会给「没打分 / 形状退化」的评审发绿灯（codex P1 的产品目标）。
process.env.FORGE_DB = ':memory:';

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { EvalExpectSchema, type Fixture } from '../src/eval/expectations.ts';

let claudeResult: { ok: boolean; result: string; costUsd: number | null; error?: string };
let judgeResult: { ok: boolean; result: string; costUsd: number | null; error?: string } = { ok: true, result: '{}', costUsd: 0 };
let lastClaudeCall: { prompt: string; cwd?: string } | null = null;
mock.module('../src/llm/runClaude.ts', {
  namedExports: {
    runClaude: async (prompt: string, opts: { cwd?: string; label?: string } = {}) => {
      lastClaudeCall = { prompt, cwd: opts.cwd };
      // LLM-judge 调用（label 'eval-judge:*'）返回 judgeResult，闸A/B 主调用返回 claudeResult。
      return { sessionId: null, raw: '', ...(opts.label?.includes('eval-judge') ? judgeResult : claudeResult) };
    },
    runClaudeBare: async () => null,
  },
});

const { evalGateA, evalGateB } = await import('../src/eval/runEval.ts');

// 一份完整、合形状的闸A产出（基线：output-contract 的全部必备维度都显式产出）。
const FULL = {
  summary: '首页 Banner 文案微调',
  repos_touched: ['U'],
  size: 'S',
  size_reason: '仅一行文案',
  open_questions: [],
  risks: [],
  confidence: 0.85,
  needs_lead: false,
  prd_score: 78,
  prd_score_dims: { clarity: 22, completeness: 18, feasibility: 20, testability: 18 },
  prd_score_reason: '边界清晰',
};

const fx: Fixture = {
  name: 'copy-tweak',
  gate: 'a',
  inputText: '把首页 Banner 文案从 A 改成 B，仅文案。',
  expect: EvalExpectSchema.parse({ open_questions: { max: 3 }, size_in: ['S', 'M'], confidence_range: [0, 1], prd_score_range: [0, 100] }),
};

test('完整形状 → 过 shape 闸，逐条 check 全过', async () => {
  claudeResult = { ok: true, result: JSON.stringify(FULL), costUsd: 0.01 };
  const r = await evalGateA(fx);
  assert.equal(r.schemaValid, true, r.error);
  assert.equal(r.checks.length > 0, true);
  assert.equal(r.checks.every((c) => c.pass), true, JSON.stringify(r.checks));
});

test('离线 eval 调 Claude 时使用隔离临时 cwd，结束后清理，不碰服务/项目 checkout', async () => {
  claudeResult = { ok: true, result: JSON.stringify(FULL), costUsd: 0.01 };
  lastClaudeCall = null;
  const r = await evalGateA(fx);
  assert.equal(r.schemaValid, true, r.error);
  assert.ok(lastClaudeCall?.cwd, '应给 claude 传入隔离 cwd');
  assert.match(lastClaudeCall.cwd!, /forge-eval-/);
  assert.notEqual(lastClaudeCall.cwd, resolve(import.meta.dirname, '..'));
  assert.equal(existsSync(lastClaudeCall.cwd!), false, 'eval 结束后应清理临时目录，避免留下副作用');
  assert.match(lastClaudeCall.prompt, /eval offline mode/);
  assert.match(lastClaudeCall.prompt, /把首页 Banner 文案从 A 改成 B/);
});

test('退化成 {} → fail（不给「啥都没产出」的评审发绿灯，即便生产 schema 会默认补全）', async () => {
  claudeResult = { ok: true, result: '{}', costUsd: 0.01 };
  const r = await evalGateA(fx);
  assert.equal(r.schemaValid, false);
  assert.match(r.error ?? '', /形状退化|缺显式字段/);
});

test('漏 prd_score / confidence → fail（守「不再打分」这条核心回归）', async () => {
  const { prd_score, confidence, ...lack } = FULL;
  claudeResult = { ok: true, result: JSON.stringify(lack), costUsd: 0.01 };
  const r = await evalGateA(fx);
  assert.equal(r.schemaValid, false);
  assert.match(r.error ?? '', /prd_score/);
  assert.match(r.error ?? '', /confidence/);
});

test('prd_score_dims 只剩空壳 → fail，点名四个子维度（光有壳不算打分）', async () => {
  claudeResult = { ok: true, result: JSON.stringify({ ...FULL, prd_score_dims: {} }), costUsd: 0.01 };
  const r = await evalGateA(fx);
  assert.equal(r.schemaValid, false);
  assert.match(r.error ?? '', /prd_score_dims\.clarity/);
  assert.match(r.error ?? '', /prd_score_dims\.testability/);
});

test('漏 needs_lead（喂 triage 升级路由）→ fail', async () => {
  const { needs_lead, ...lack } = FULL;
  claudeResult = { ok: true, result: JSON.stringify(lack), costUsd: 0.01 };
  const r = await evalGateA(fx);
  assert.equal(r.schemaValid, false);
  assert.match(r.error ?? '', /needs_lead/);
});

test('形状达标但越界（size=L）→ shape 过、逐条 check 报 fail（区分两类回归）', async () => {
  claudeResult = { ok: true, result: JSON.stringify({ ...FULL, size: 'L' }), costUsd: 0.01 };
  const r = await evalGateA(fx);
  assert.equal(r.schemaValid, true); // 形状没退化
  assert.equal(r.checks.some((c) => c.name.includes('size') && !c.pass), true); // 但判大了 → check 失败
});

test('claude 调用失败 → fail，不误判为通过', async () => {
  claudeResult = { ok: false, result: '', costUsd: null, error: '超时' };
  const r = await evalGateA(fx);
  assert.equal(r.schemaValid, false);
  assert.match(r.error ?? '', /claude 调用失败/);
});

test('输出里根本没有 JSON 块 → fail', async () => {
  claudeResult = { ok: true, result: '抱歉我无法完成', costUsd: 0.01 };
  const r = await evalGateA(fx);
  assert.equal(r.schemaValid, false);
  assert.match(r.error ?? '', /无可解析 JSON/);
});

// ── 闸B（#2）裁判链路 ──
const FULL_B = {
  summary: '钱包充值技术方案',
  key_decisions: { contract_break: false, db_migration: true },
  tech_design_markdown: '## 技术方案\n余额账户表 + 行级锁 + 幂等单号…'.padEnd(220, '细'),
  acceptance: { contracts: [{ repo: 'C', surface: 'POST /api/v1/wallet/recharge' }], scenarios: [{ id: 'AC1', repo: 'C', gherkin: 'Given 余额 0 When 充值 100 Then 余额 100' }] },
  multi_repo: true,
  issue_specs: [{ repo: 'C', title: '充值后端' }, { repo: 'U', title: '钱包页' }],
  confidence: 0.7,
};
const fxB: Fixture = {
  name: 'recharge-gateb',
  gate: 'b',
  inputText: '钱包充值真源（已多轮评审）…余额不过期、未消费可退…',
  expect: EvalExpectSchema.parse({ gate: 'b', issue_specs_min: 1, acceptance_contracts_min: 1, acceptance_scenarios_min: 1, tech_design_min_chars: 200, confidence_range: [0, 1] }),
};

test('闸B 完整形状 → 过 shape 闸，逐条 check 全过', async () => {
  claudeResult = { ok: true, result: JSON.stringify(FULL_B), costUsd: 0.05 };
  const r = await evalGateB(fxB);
  assert.equal(r.schemaValid, true, r.error);
  assert.equal(r.checks.every((c) => c.pass), true, JSON.stringify(r.checks));
});

test('闸B acceptance 退化成空壳 → fail，点名 contracts/scenarios（drift 对账基准不能空）', async () => {
  claudeResult = { ok: true, result: JSON.stringify({ ...FULL_B, acceptance: {} }), costUsd: 0.05 };
  const r = await evalGateB(fxB);
  assert.equal(r.schemaValid, false);
  assert.match(r.error ?? '', /acceptance\.contracts/);
  assert.match(r.error ?? '', /acceptance\.scenarios/);
});

test('闸B 形状达标但 0 issue/契约 → shape 过、逐条 check 报 fail', async () => {
  claudeResult = { ok: true, result: JSON.stringify({ ...FULL_B, issue_specs: [], acceptance: { contracts: [], scenarios: [] } }), costUsd: 0.05 };
  const r = await evalGateB(fxB);
  assert.equal(r.schemaValid, true); // 字段都在
  assert.equal(r.checks.some((c) => c.name.includes('issue_specs') && !c.pass), true);
  assert.equal(r.checks.some((c) => c.name.includes('contracts') && !c.pass), true);
});

// ── 闸B + acceptance LLM-judge（#3）──
const fxBJudge: Fixture = {
  ...fxB,
  name: 'recharge-gateb-judge',
  expect: EvalExpectSchema.parse({ gate: 'b', issue_specs_min: 1, acceptance_judge: { min_coverage: 55, min_testability: 55, require_declarative: true } }),
};

test('acceptance judge 通过 → judge 的 check 进逐条 + 指标落 metrics', async () => {
  claudeResult = { ok: true, result: JSON.stringify(FULL_B), costUsd: 0.05 };
  judgeResult = { ok: true, result: JSON.stringify({ coverage: 80, testability: 75, declarative: true, issues: [], verdict: 'good' }), costUsd: 0.02 };
  const r = await evalGateB(fxBJudge);
  assert.equal(r.schemaValid, true, r.error);
  assert.equal(r.checks.every((c) => c.pass), true, JSON.stringify(r.checks));
  assert.equal(r.checks.some((c) => c.name.includes('覆盖')), true);
  assert.equal(r.metrics?.acceptance_coverage, 80);
  // judge 这一发的成本累加进 sample（主调用 0.05 + judge 0.02）——否则总成本/落盘少算
  assert.equal(Math.round((r.costUsd ?? 0) * 100) / 100, 0.07);
});

test('acceptance judge 判弱 → 覆盖/声明式 check 失败，问题带进 detail', async () => {
  claudeResult = { ok: true, result: JSON.stringify(FULL_B), costUsd: 0.05 };
  judgeResult = { ok: true, result: JSON.stringify({ coverage: 30, testability: 40, declarative: false, issues: ['漏退款路径'], verdict: 'weak' }), costUsd: 0.02 };
  const r = await evalGateB(fxBJudge);
  assert.equal(r.schemaValid, true); // 结构没问题，是语义弱
  assert.equal(r.checks.find((c) => c.name.includes('覆盖'))?.pass, false);
  assert.match(r.checks.find((c) => c.name.includes('覆盖'))!.detail, /漏退款路径/);
  assert.equal(r.checks.find((c) => c.name.includes('声明式'))?.pass, false);
});

test('acceptance judge 调用失败 → 转成一条失败 check，不中断整轮', async () => {
  claudeResult = { ok: true, result: JSON.stringify(FULL_B), costUsd: 0.05 };
  judgeResult = { ok: false, result: '', costUsd: null, error: '超时' };
  const r = await evalGateB(fxBJudge);
  assert.equal(r.checks.some((c) => c.name.includes('LLM-judge') && !c.pass), true);
});
