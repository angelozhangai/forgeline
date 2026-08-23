// Integration, at no cost: evalGateA's real judging path. runClaude is mocked to feed it various outputs,
// proving eval never gives a green light to a review that did not score the PRD or whose shape has degraded
// (the product goal behind codex's P1).
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
      // The LLM-judge call (label 'eval-judge:*') returns judgeResult; the main gate A/B call returns claudeResult.
      return { sessionId: null, raw: '', ...(opts.label?.includes('eval-judge') ? judgeResult : claudeResult) };
    },
    runClaudeBare: async () => null,
  },
});

const { evalGateA, evalGateB } = await import('../src/eval/runEval.ts');

// A complete, well-shaped gate A output -- the baseline, with every dimension the output contract requires
// stated explicitly.
const FULL = {
  summary: 'a small copy tweak to the home page banner',
  repos_touched: ['U'],
  size: 'S',
  size_reason: 'a single line of copy',
  open_questions: [],
  risks: [],
  confidence: 0.85,
  needs_lead: false,
  prd_score: 78,
  prd_score_dims: { clarity: 22, completeness: 18, feasibility: 20, testability: 18 },
  prd_score_reason: 'the boundaries are clear',
};

const fx: Fixture = {
  name: 'copy-tweak',
  gate: 'a',
  // The fixture's PRD text is deliberately non-English, written as escapes. The source of this repo is
  // English; the requirement documents it ingests are not, and this is what keeps that half of the rule
  // covered end to end -- the text has to reach the prompt unchanged.
  inputText: '\u628a\u9996\u9875 Banner \u6587\u6848\u4ece A \u6539\u6210 B\uff0c\u4ec5\u6587\u6848\u3002',
  expect: EvalExpectSchema.parse({ open_questions: { max: 3 }, size_in: ['S', 'M'], confidence_range: [0, 1], prd_score_range: [0, 100] }),
};

test('a complete shape passes the shape gate, and every individual check passes', async () => {
  claudeResult = { ok: true, result: JSON.stringify(FULL), costUsd: 0.01 };
  const r = await evalGateA(fx);
  assert.equal(r.schemaValid, true, r.error);
  assert.equal(r.checks.length > 0, true);
  assert.equal(r.checks.every((c) => c.pass), true, JSON.stringify(r.checks));
});

test('an offline eval calls claude in an isolated temporary cwd and cleans it up afterwards, touching neither the service nor the project checkout', async () => {
  claudeResult = { ok: true, result: JSON.stringify(FULL), costUsd: 0.01 };
  lastClaudeCall = null;
  const r = await evalGateA(fx);
  assert.equal(r.schemaValid, true, r.error);
  assert.ok(lastClaudeCall?.cwd, 'claude should be given an isolated cwd');
  assert.match(lastClaudeCall.cwd!, /forge-eval-/);
  assert.notEqual(lastClaudeCall.cwd, resolve(import.meta.dirname, '..'));
  assert.equal(existsSync(lastClaudeCall.cwd!), false, 'the temporary directory should be cleaned up when the eval finishes, leaving no side effects');
  assert.match(lastClaudeCall.prompt, /eval offline mode/);
  assert.match(lastClaudeCall.prompt, /\u628a\u9996\u9875 Banner \u6587\u6848\u4ece A \u6539\u6210 B/); // the non-English PRD text reaches the prompt unchanged
});

test('degraded to {} -> fail (a review that produced nothing gets no green light, even though the production schema would fill in defaults)', async () => {
  claudeResult = { ok: true, result: '{}', costUsd: 0.01 };
  const r = await evalGateA(fx);
  assert.equal(r.schemaValid, false);
  assert.match(r.error ?? '', /shape has degraded|missing the explicit fields/);
});

test('missing prd_score or confidence -> fail (guarding against the core regression of quietly no longer scoring)', async () => {
  const { prd_score, confidence, ...lack } = FULL;
  claudeResult = { ok: true, result: JSON.stringify(lack), costUsd: 0.01 };
  const r = await evalGateA(fx);
  assert.equal(r.schemaValid, false);
  assert.match(r.error ?? '', /prd_score/);
  assert.match(r.error ?? '', /confidence/);
});

test('prd_score_dims reduced to an empty shell -> fail, naming all four sub-dimensions (a shell is not a score)', async () => {
  claudeResult = { ok: true, result: JSON.stringify({ ...FULL, prd_score_dims: {} }), costUsd: 0.01 };
  const r = await evalGateA(fx);
  assert.equal(r.schemaValid, false);
  assert.match(r.error ?? '', /prd_score_dims\.clarity/);
  assert.match(r.error ?? '', /prd_score_dims\.testability/);
});

test('missing needs_lead, which feeds the triage escalation routing -> fail', async () => {
  const { needs_lead, ...lack } = FULL;
  claudeResult = { ok: true, result: JSON.stringify(lack), costUsd: 0.01 };
  const r = await evalGateA(fx);
  assert.equal(r.schemaValid, false);
  assert.match(r.error ?? '', /needs_lead/);
});

test('a valid shape that is out of range (size=L) -> the shape gate passes and the individual check fails, keeping the two kinds of regression apart', async () => {
  claudeResult = { ok: true, result: JSON.stringify({ ...FULL, size: 'L' }), costUsd: 0.01 };
  const r = await evalGateA(fx);
  assert.equal(r.schemaValid, true); // the shape has not degraded
  assert.equal(r.checks.some((c) => c.name.includes('size') && !c.pass), true); // but it sized the work too high -> the check fails
});

test('the claude call failed -> fail, never mistaken for a pass', async () => {
  claudeResult = { ok: false, result: '', costUsd: null, error: 'timed out' };
  const r = await evalGateA(fx);
  assert.equal(r.schemaValid, false);
  assert.match(r.error ?? '', /the claude call failed/);
});

test('the output contains no JSON block at all -> fail', async () => {
  claudeResult = { ok: true, result: 'sorry, I cannot do that', costUsd: 0.01 };
  const r = await evalGateA(fx);
  assert.equal(r.schemaValid, false);
  assert.match(r.error ?? '', /no parseable JSON/);
});

// -- Gate B's judging path (#2) --
const FULL_B = {
  summary: 'the technical plan for topping up a wallet',
  key_decisions: { contract_break: false, db_migration: true },
  tech_design_markdown: '## Technical plan\na balance table, row-level locks, and an idempotency key...'.padEnd(220, '.'),
  acceptance: { contracts: [{ repo: 'C', surface: 'POST /api/v1/wallet/recharge' }], scenarios: [{ id: 'AC1', repo: 'C', gherkin: 'Given a balance of 0 When 100 is topped up Then the balance is 100' }] },
  multi_repo: true,
  issue_specs: [{ repo: 'C', title: 'the top-up back end' }, { repo: 'U', title: 'the wallet page' }],
  confidence: 0.7,
};
const fxB: Fixture = {
  name: 'recharge-gateb',
  gate: 'b',
  inputText: '\u94b1\u5305\u5145\u503c\u771f\u6e90\uff08\u5df2\u591a\u8f6e\u8bc4\u5ba1\uff09\u2026\u4f59\u989d\u4e0d\u8fc7\u671f\u3001\u672a\u6d88\u8d39\u53ef\u9000\u2026', // non-English again, as escapes -- see the note on fx above
  expect: EvalExpectSchema.parse({ gate: 'b', issue_specs_min: 1, acceptance_contracts_min: 1, acceptance_scenarios_min: 1, tech_design_min_chars: 200, confidence_range: [0, 1] }),
};

test('a complete gate B shape passes the shape gate, and every individual check passes', async () => {
  claudeResult = { ok: true, result: JSON.stringify(FULL_B), costUsd: 0.05 };
  const r = await evalGateB(fxB);
  assert.equal(r.schemaValid, true, r.error);
  assert.equal(r.checks.every((c) => c.pass), true, JSON.stringify(r.checks));
});

test('gate B acceptance reduced to an empty shell -> fail, naming contracts and scenarios (the baseline drift reconciles against must never be empty)', async () => {
  claudeResult = { ok: true, result: JSON.stringify({ ...FULL_B, acceptance: {} }), costUsd: 0.05 };
  const r = await evalGateB(fxB);
  assert.equal(r.schemaValid, false);
  assert.match(r.error ?? '', /acceptance\.contracts/);
  assert.match(r.error ?? '', /acceptance\.scenarios/);
});

test('a valid gate B shape with no issues and no contracts -> the shape gate passes and the individual checks fail', async () => {
  claudeResult = { ok: true, result: JSON.stringify({ ...FULL_B, issue_specs: [], acceptance: { contracts: [], scenarios: [] } }), costUsd: 0.05 };
  const r = await evalGateB(fxB);
  assert.equal(r.schemaValid, true); // every field is present
  assert.equal(r.checks.some((c) => c.name.includes('issue_specs') && !c.pass), true);
  assert.equal(r.checks.some((c) => c.name.includes('contracts') && !c.pass), true);
});

// -- Gate B plus the acceptance LLM judge (#3) --
const fxBJudge: Fixture = {
  ...fxB,
  name: 'recharge-gateb-judge',
  expect: EvalExpectSchema.parse({ gate: 'b', issue_specs_min: 1, acceptance_judge: { min_coverage: 55, min_testability: 55, require_declarative: true } }),
};

test('the acceptance judge passes -> its checks join the individual ones and its numbers land in metrics', async () => {
  claudeResult = { ok: true, result: JSON.stringify(FULL_B), costUsd: 0.05 };
  judgeResult = { ok: true, result: JSON.stringify({ coverage: 80, testability: 75, declarative: true, issues: [], verdict: 'good' }), costUsd: 0.02 };
  const r = await evalGateB(fxBJudge);
  assert.equal(r.schemaValid, true, r.error);
  assert.equal(r.checks.every((c) => c.pass), true, JSON.stringify(r.checks));
  assert.equal(r.checks.some((c) => c.name.includes('coverage')), true);
  assert.equal(r.metrics?.acceptance_coverage, 80);
  // The judge's own call is added to the sample's cost (0.05 for the main call plus 0.02 for the judge) --
  // otherwise the total cost, and what is written to disk, come out short.
  assert.equal(Math.round((r.costUsd ?? 0) * 100) / 100, 0.07);
});

test('the acceptance judge finds it weak -> the coverage and declarative checks fail, and its findings are carried into the detail', async () => {
  claudeResult = { ok: true, result: JSON.stringify(FULL_B), costUsd: 0.05 };
  judgeResult = { ok: true, result: JSON.stringify({ coverage: 30, testability: 40, declarative: false, issues: ['the refund path is missing'], verdict: 'weak' }), costUsd: 0.02 };
  const r = await evalGateB(fxBJudge);
  assert.equal(r.schemaValid, true); // the structure is fine -- it is the substance that is weak
  assert.equal(r.checks.find((c) => c.name.includes('coverage'))?.pass, false);
  assert.match(r.checks.find((c) => c.name.includes('coverage'))!.detail, /the refund path is missing/);
  assert.equal(r.checks.find((c) => c.name.includes('declarative'))?.pass, false);
});

test('the acceptance judge call fails -> it becomes one failed check rather than aborting the whole round', async () => {
  claudeResult = { ok: true, result: JSON.stringify(FULL_B), costUsd: 0.05 };
  judgeResult = { ok: false, result: '', costUsd: null, error: 'timed out' };
  const r = await evalGateB(fxBJudge);
  assert.equal(r.checks.some((c) => c.name.includes('LLM-judge') && !c.pass), true);
});
