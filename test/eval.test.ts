// Regression on the **pure logic** of the golden eval (runs in CI, costs nothing): the fixtures do not rot,
// the expectation comparison is right, and the report aggregates correctly.
// The real claude calls (evalGateA / runEval) are deliberately not tested here — they cost money and only a
// manual `forge eval` runs them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFixtures, checkGateA, checkGateB, missingRawFields, missingGateBFields, REQUIRED_GATE_A_FIELDS, REQUIRED_GATE_B_FIELDS, EvalExpectSchema } from '../src/eval/expectations.ts';
import { GateASchema, GateBSchema } from '../src/gates/envelopes.ts';

// Build a valid Gate A output through the schema, then override the fields a test needs.
function env(over: Record<string, unknown>) {
  return GateASchema.parse(over);
}

test('loadFixtures: every real fixture under fixtures/eval exists, has a non-empty input, and an expect that matches the schema (guarding the fixtures against rot)', () => {
  const fxs = loadFixtures();
  assert.ok(fxs.length >= 2, `there should be at least 2 golden fixtures, but there are ${fxs.length}`);
  for (const fx of fxs) {
    assert.ok(fx.inputText.trim().length > 50, `${fx.name}'s input (prd.md / prd-truth.md) should not be empty`);
    assert.ok(['a', 'b'].includes(fx.gate), `${fx.name}'s gate should be a or b`);
    // EvalExpectSchema is strict, so an extra field throws while loadFixtures parses; this confirms the
    // structure is usable.
    assert.doesNotThrow(() => EvalExpectSchema.parse(fx.expect));
  }
  // At least one Gate B fixture (the safety net #2 put in place)
  assert.ok(fxs.some((f) => f.gate === 'b'), 'there should be at least one Gate B fixture');
});

test('hardening the harness: every Gate B fixture declares at least one Gate-B-specific expectation (guarding against degrading into a false green that checks nothing)', () => {
  // A Gate B fixture that says gate:b but declares no issue, acceptance or technical-plan floor would have
  // the eval "pass everything" while guarding nothing.
  // This CI gate holds the line: a gate:b fixture must carry at least one Gate-B-specific assertion (a pure
  // structural check, costing nothing).
  const GATE_B_KEYS = ['issue_specs_min', 'issue_repos_include', 'acceptance_contracts_min', 'acceptance_scenarios_min', 'tech_design_min_chars', 'multi_repo', 'acceptance_judge'] as const;
  for (const fx of loadFixtures().filter((f) => f.gate === 'b')) {
    const has = GATE_B_KEYS.some((k) => (fx.expect as Record<string, unknown>)[k] !== undefined);
    assert.ok(has, `the Gate B fixture ${fx.name} must declare at least one Gate-B-specific expectation (one of ${GATE_B_KEYS.join('/')})`);
  }
});

test('the data-export fixture: gate:a, size_in excludes S, and risks_min is set (extending golden into the data and privacy domain)', () => {
  const fx = loadFixtures(undefined, 'data-export');
  assert.equal(fx.length, 1);
  assert.equal(fx[0].gate, 'a');
  const sizeIn = fx[0].expect.size_in ?? [];
  assert.ok(sizeIn.length > 0 && !sizeIn.includes('S'), 'a data export should not be allowed to be judged a trivial S');
  assert.equal(fx[0].expect.risks_min, 1);
});

test('loadFixtures --only: takes just the named fixture', () => {
  const all = loadFixtures();
  const one = loadFixtures(undefined, all[0].name);
  assert.equal(one.length, 1);
  assert.equal(one[0].name, all[0].name);
  assert.equal(loadFixtures(undefined, 'a-fixture-that-does-not-exist').length, 0);
});

test('checkGateA: open_questions min/max, and a topic being hit', () => {
  const e = env({ open_questions: [{ q: 'does the balance expire?', suggestion: 'suggest it does not expire' }, { q: 'how are refunds handled?' }] });
  const r = checkGateA(e, EvalExpectSchema.parse({ open_questions: { min: 2, max: 3, topics: ['expire', 'refund'] } }));
  assert.equal(r.every((c) => c.pass), true, JSON.stringify(r));

  // min not met -> fails
  const r2 = checkGateA(env({ open_questions: [{ q: 'only one' }] }), EvalExpectSchema.parse({ open_questions: { min: 2 } }));
  assert.equal(r2.find((c) => c.name.includes('>= 2'))?.pass, false);

  // The topic is not hit -> fails (the hit is checked against q and suggestion joined together)
  const r3 = checkGateA(env({ open_questions: [{ q: 'an unrelated question' }] }), EvalExpectSchema.parse({ open_questions: { topics: ['expire'] } }));
  assert.equal(r3[0].pass, false);
  assert.match(r3[0].detail, /no open_question mentions it/);
});

// Source is English, input is not: a topic is matched against the model's output, which follows the language
// of the requirement document. Topic matching is a plain substring test and must stay script-agnostic — if
// it ever grew a word-boundary or case rule tuned for English, this would catch it. Built from code points
// rather than written as literal characters (see test/english-only.test.ts).
test('checkGateA: a topic written in another language is matched exactly the same way', () => {
  const expire = String.fromCodePoint(0x8fc7, 0x671f); // "expire"
  const question = String.fromCodePoint(0x4f59, 0x989d, 0x4f1a, 0x8fc7, 0x671f, 0x5417, 0xff1f); // "does the balance expire?"
  const hit = checkGateA(env({ open_questions: [{ q: question }] }), EvalExpectSchema.parse({ open_questions: { topics: [expire] } }));
  assert.equal(hit[0].pass, true, JSON.stringify(hit));
  const miss = checkGateA(env({ open_questions: [{ q: 'an unrelated question' }] }), EvalExpectSchema.parse({ open_questions: { topics: [expire] } }));
  assert.equal(miss[0].pass, false);
});

test('checkGateA: size_in / risks_min / the ranges', () => {
  const e = env({ size: 'L', risks: [{ area: 'money' }, { area: 'concurrency' }], confidence: 0.6, prd_score: 72 });
  const x = EvalExpectSchema.parse({ size_in: ['M', 'L'], risks_min: 1, confidence_range: [0, 1], prd_score_range: [0, 100] });
  assert.equal(checkGateA(e, x).every((c) => c.pass), true);

  // The size is not in the set -> fails
  const rS = checkGateA(env({ size: 'XL' }), EvalExpectSchema.parse({ size_in: ['S', 'M'] }));
  assert.equal(rS[0].pass, false);
  assert.match(rS[0].detail, /actual XL/);

  // Out of range -> fails
  const rR = checkGateA(env({ confidence: 1.5 }), EvalExpectSchema.parse({ confidence_range: [0, 1] }));
  assert.equal(rR[0].pass, false);
});

test('checkGateA: an expectation that was not declared produces no check (only what is written is checked)', () => {
  const r = checkGateA(env({ open_questions: [{ q: 'x' }] }), EvalExpectSchema.parse({})); // no expectations
  assert.equal(r.length, 0);
});

test('missingRawFields: the raw shape contract blocks a "degraded output" (before zod injects any defaults)', () => {
  // {} -> everything missing (the heaviest regression: the model produced no dimension at all, but the
  // production schema would fill them in)
  assert.deepEqual(missingRawFields({}).sort(), [...REQUIRED_GATE_A_FIELDS].sort());
  // The complete-shape baseline: all 11 top-level fields plus all four prd_score_dims produced explicitly ->
  // nothing missing.
  const full = {
    summary: 's', repos_touched: ['C'], size: 'M', size_reason: 'r', open_questions: [], risks: [],
    confidence: 0.5, needs_lead: false, prd_score: 70,
    prd_score_dims: { clarity: 18, completeness: 16, feasibility: 19, testability: 17 }, prd_score_reason: 'x',
  };
  assert.deepEqual(missingRawFields(full), []);
  // prd_score or confidence dropped -> named exactly (the "it stopped scoring" case Codex raised)
  const { prd_score, confidence, ...lack } = full;
  assert.deepEqual(missingRawFields(lack).sort(), ['confidence', 'prd_score']);
  // needs_lead or repos_touched dropped -> named (they feed the triage escalation routing and cannot go missing)
  const { needs_lead, ...noLead } = full;
  assert.deepEqual(missingRawFields(noLead), ['needs_lead']);
  const { repos_touched, ...noRepos } = full;
  assert.deepEqual(missingRawFields(noRepos), ['repos_touched']);
  // prd_score_dims given as an empty object -> the top level is there but all four dimensions are missing,
  // each named exactly ("an empty shell is not a score")
  assert.deepEqual(missingRawFields({ ...full, prd_score_dims: {} }).sort(), ['prd_score_dims.clarity', 'prd_score_dims.completeness', 'prd_score_dims.feasibility', 'prd_score_dims.testability'].sort());
  // prd_score_dims missing one dimension -> only that one is named
  assert.deepEqual(missingRawFields({ ...full, prd_score_dims: { clarity: 1, completeness: 1, feasibility: 1 } }), ['prd_score_dims.testability']);
  // prd_score_dims present but not an object (a broken shape) -> all four are named
  assert.deepEqual(missingRawFields({ ...full, prd_score_dims: [] }).sort(), ['prd_score_dims.clarity', 'prd_score_dims.completeness', 'prd_score_dims.feasibility', 'prd_score_dims.testability'].sort());
  // An explicit null counts as missing too (present, but nothing was really scored)
  assert.deepEqual(missingRawFields({ ...full, prd_score: null }), ['prd_score']);
  // An empty array or a score of 0 are valid values (the dimension was produced, it is just empty or low) — not missing
  assert.deepEqual(missingRawFields({ ...full, open_questions: [], repos_touched: [], prd_score: 0 }), []);
  // {} -> all 11 top-level fields missing (with prd_score_dims missing, the sub-dimensions are not named twice)
  assert.deepEqual(missingRawFields({}).sort(), [...REQUIRED_GATE_A_FIELDS].sort());
  // Not an object (an array, null, a string) -> everything missing at the top level
  assert.equal(missingRawFields([]).length, REQUIRED_GATE_A_FIELDS.length);
  assert.equal(missingRawFields(null).length, REQUIRED_GATE_A_FIELDS.length);
  assert.equal(missingRawFields('{}').length, REQUIRED_GATE_A_FIELDS.length);
});

// ── Gate B (#2) ──
function envB(over: Record<string, unknown>) {
  return GateBSchema.parse(over);
}

test('missingGateBFields: the Gate B shape contract, drilling into acceptance for contracts and scenarios', () => {
  assert.deepEqual(missingGateBFields({}).sort(), [...REQUIRED_GATE_B_FIELDS].sort());
  const full = {
    summary: 's', key_decisions: { x: 1 }, tech_design_markdown: '## The design...', acceptance: { contracts: [{ repo: 'C', surface: 'POST /x' }], scenarios: [{ id: 'AC1', gherkin: 'Given...' }] },
    multi_repo: true, issue_specs: [{ repo: 'C', title: 't' }], confidence: 0.7,
  };
  assert.deepEqual(missingGateBFields(full), []);
  // acceptance or issue_specs dropped -> named
  const { acceptance, ...noAcc } = full;
  assert.ok(missingGateBFields(noAcc).includes('acceptance'));
  // acceptance as an empty shell (no contracts or scenarios) -> drilled into and named (the baseline for
  // drift reconciliation must not be empty)
  assert.deepEqual(missingGateBFields({ ...full, acceptance: {} }).sort(), ['acceptance.contracts', 'acceptance.scenarios'].sort());
  // acceptance not an object -> both sub-keys named
  assert.deepEqual(missingGateBFields({ ...full, acceptance: [] }).sort(), ['acceptance.contracts', 'acceptance.scenarios'].sort());
});

test('checkGateB: the issue / contracts / scenarios floors, plus multi_repo and the body length', () => {
  const e = envB({
    tech_design_markdown: 'x'.repeat(300),
    acceptance: { contracts: [{ repo: 'C', surface: 's' }], scenarios: [{ id: 'AC1' }, { id: 'AC2' }] },
    multi_repo: true, issue_specs: [{ repo: 'C', title: 't' }, { repo: 'U', title: 't2' }], confidence: 0.6,
  });
  const x = EvalExpectSchema.parse({ gate: 'b', issue_specs_min: 1, acceptance_contracts_min: 1, acceptance_scenarios_min: 2, tech_design_min_chars: 200, multi_repo: true, confidence_range: [0, 1] });
  assert.equal(checkGateB(e, x).every((c) => c.pass), true, JSON.stringify(checkGateB(e, x)));

  // Degraded: no issues, an empty acceptance, a short body, and misjudged as single-repo -> each fails
  const weak = envB({ tech_design_markdown: 'short', acceptance: { contracts: [], scenarios: [] }, multi_repo: false, issue_specs: [] });
  const r = checkGateB(weak, x);
  assert.equal(r.find((c) => c.name.includes('issue_specs'))?.pass, false);
  assert.equal(r.find((c) => c.name.includes('contracts'))?.pass, false);
  assert.equal(r.find((c) => c.name.includes('scenarios'))?.pass, false);
  assert.equal(r.find((c) => c.name.includes('tech_design'))?.pass, false);
  assert.equal(r.find((c) => c.name.includes('multi_repo'))?.pass, false);
});

test('checkGateB: issue_repos_include guards real coverage — two issues both piled into the backend (C) are still blocked (even with multi_repo:true)', () => {
  const xr = EvalExpectSchema.parse({ gate: 'b', issue_specs_min: 2, multi_repo: true, issue_repos_include: ['C', 'U'] });
  // Degraded: multi_repo=true with 2 issues, but both in demo (the front-end work in example-web was dropped)
  const backendOnly = envB({ multi_repo: true, issue_specs: [{ repo: 'C', title: 'a' }, { repo: 'C', title: 'b' }] });
  const r1 = checkGateB(backendOnly, xr);
  assert.equal(r1.find((c) => c.name.includes('cover the repos'))?.pass, false);
  assert.match(r1.find((c) => c.name.includes('cover the repos'))!.detail, /missing U/);
  // The count and multi_repo checks are both still green — which is exactly the degradation they cannot
  // catch, and what the repo coverage check is there to catch instead
  assert.equal(r1.find((c) => c.name.includes('issue_specs'))?.pass, true);
  assert.equal(r1.find((c) => c.name.includes('multi_repo'))?.pass, true);
  // Genuinely covering C and U -> passes
  const both = envB({ multi_repo: true, issue_specs: [{ repo: 'C', title: 'a' }, { repo: 'U', title: 'b' }] });
  assert.equal(checkGateB(both, xr).every((c) => c.pass), true);
});

// The tests for summarize / formatReport / aggregate / diffRuns / store live in test/eval-aggregate.test.ts
// (multi-sample, trend, persistence).
