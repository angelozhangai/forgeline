import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GateASchema,
  GateBSchema,
  VerdictSchema,
  askId,
  parseHumanAsks,
  parseOpenQuestions,
  humanAsksToDecisions,
  answerableDecisions,
  composeDecisionAnswer,
} from '../src/gates/envelopes.ts';

// The LLM output contract: a missing field must have a safe default (a model omitting a field must never
// crash us), while a genuinely required field must error.
test('GateASchema: an empty object -> safe defaults', () => {
  const e = GateASchema.parse({});
  assert.deepEqual(e.repos_touched, []);
  assert.deepEqual(e.open_questions, []);
  assert.equal(e.confidence, 0);
  assert.equal(e.needs_lead, false);
});

test('GateASchema: a missing PRD score -> 0, all dimensions 0, and an empty reason', () => {
  const e = GateASchema.parse({});
  assert.equal(e.prd_score, 0);
  assert.deepEqual(e.prd_score_dims, { clarity: 0, completeness: 0, feasibility: 0, testability: 0 });
  assert.equal(e.prd_score_reason, '');
});

test('GateASchema: the PRD score passes through (leniently, with no boundary enforcement — normalisation is normScore\'s job)', () => {
  const e = GateASchema.parse({
    prd_score: 72,
    prd_score_dims: { clarity: 18, completeness: 15, feasibility: 22, testability: 17 },
    prd_score_reason: 'acceptance criteria are missing',
  });
  assert.equal(e.prd_score, 72);
  assert.equal(e.prd_score_dims.completeness, 15);
  assert.equal(e.prd_score_reason, 'acceptance criteria are missing');
});

test('GateASchema: an open_question with no severity -> defaults to med', () => {
  const e = GateASchema.parse({ open_questions: [{ q: 'a question' }] });
  assert.equal(e.open_questions[0].severity, 'med');
  assert.equal(e.open_questions[0].suggestion, '');
});

test('GateBSchema: defaults to multi_repo=false, issue_specs=[], and an empty acceptance', () => {
  const e = GateBSchema.parse({ summary: 'x' });
  assert.equal(e.multi_repo, false);
  assert.deepEqual(e.issue_specs, []);
  assert.deepEqual(e.key_decisions, {});
  assert.deepEqual(e.acceptance, { contracts: [], scenarios: [] });
});

test('GateBSchema: acceptance passes through, and a scenario missing id/repo gets defaults', () => {
  const e = GateBSchema.parse({
    acceptance: {
      contracts: [{ repo: 'C', surface: 'POST /api/v1/pay/refund → 200|409' }],
      scenarios: [{ gherkin: 'Given a\nWhen b\nThen c' }],
    },
  });
  assert.equal(e.acceptance.contracts[0].surface.includes('refund'), true);
  assert.equal(e.acceptance.scenarios[0].gherkin.includes('Given'), true);
  assert.equal(e.acceptance.scenarios[0].id, ''); // no id -> defaults to empty
  assert.equal(e.acceptance.scenarios[0].repo, ''); // no repo -> defaults to empty (general)
});

test('GateBSchema: an issue_spec must carry repo and title, and errors without them', () => {
  assert.throws(() => GateBSchema.parse({ issue_specs: [{ title: 'no repo' }] }));
  const ok = GateBSchema.parse({ issue_specs: [{ repo: 'A', title: 't' }] });
  assert.equal(ok.issue_specs[0].type, 'feat'); // default
  assert.equal(ok.issue_specs[0].prio, 'P2');
});

test('VerdictSchema: LGTM/CHANGES_REQUESTED, older values normalised, and verdict required', () => {
  // A missing verdict no longer defaults to letting it through; it errors (handed to the self-healing re-ask).
  assert.throws(() => VerdictSchema.parse({}));
  // Valid: LGTM (empty findings) / CHANGES_REQUESTED (non-empty findings).
  assert.equal(VerdictSchema.parse({ verdict: 'LGTM' }).verdict, 'LGTM');
  assert.equal(VerdictSchema.parse({ verdict: 'LGTM', findings: [] }).verdict, 'LGTM');
  // Older values are normalised automatically (case-insensitively).
  assert.equal(VerdictSchema.parse({ verdict: 'clean' }).verdict, 'LGTM');
  assert.equal(VerdictSchema.parse({ verdict: 'Clean' }).verdict, 'LGTM');
  assert.equal(VerdictSchema.parse({ verdict: 'needs_revision', findings: [{ issue: 'x' }] }).verdict, 'CHANGES_REQUESTED');
  // An unknown value errors (let the self-healing re-ask; never guess).
  assert.throws(() => VerdictSchema.parse({ verdict: 'maybe' }));
});

test('VerdictSchema: verdict/findings consistency is enforced (a contradiction errors)', () => {
  assert.throws(() => VerdictSchema.parse({ verdict: 'LGTM', findings: [{ issue: 'x' }] }), /LGTM/);
  assert.throws(() => VerdictSchema.parse({ verdict: 'CHANGES_REQUESTED', findings: [] }));
  const v = VerdictSchema.parse({ verdict: 'CHANGES_REQUESTED', findings: [{ issue: 'x' }] });
  assert.equal(v.verdict, 'CHANGES_REQUESTED');
});

test('VerdictSchema: a finding without an issue errors; the rest have defaults', () => {
  assert.throws(() => VerdictSchema.parse({ verdict: 'CHANGES_REQUESTED', findings: [{ fix: 'x' }] }));
  const v = VerdictSchema.parse({ verdict: 'CHANGES_REQUESTED', findings: [{ issue: 'bug' }] });
  assert.equal(v.findings[0].severity, 'med');
});

test('askId: purely positional H{n}, never trusting the LLM\'s id (which rules out duplicate ids crossing questions)', () => {
  assert.equal(askId(0), 'H1');
  assert.equal(askId(2), 'H3');
});

// -- The decision card primitive (backward compatibility + render/compose alignment) --
test('DecisionOption: older string[] options -> normalised to {label,recommended,impact} (protecting in-flight sessions)', () => {
  const asks = parseHumanAsks(JSON.stringify([{ id: 'H1', question: 'Q', options: ['Original route', 'Balance'] }]));
  assert.equal(asks.length, 1);
  assert.deepEqual(asks[0].options[0], { label: 'Original route', recommended: false, impact: '' });
  assert.equal(asks[0].options[1].label, 'Balance');
});

test('open_questions.options: absent -> []; parseOpenQuestions normalises older drafts (no options does not crash)', () => {
  const e = GateASchema.parse({ open_questions: [{ q: 'x' }] });
  assert.deepEqual(e.open_questions[0].options, []);
  const oq = parseOpenQuestions(JSON.stringify({ open_questions: [{ q: 'y', options: ['A'] }] }));
  assert.equal(oq[0].options[0].label, 'A');
  assert.deepEqual(parseOpenQuestions('not json'), []); // bad data -> empty, no throw
});

test('answerableDecisions: items with no options are skipped, but the ids stay positional H{n} (render and compose share one source -> questions can never be crossed)', () => {
  const items = [
    { prompt: 'Q1', options: [{ label: 'a', recommended: false, impact: '' }], severity: 'med', hint: '' },
    { prompt: 'Q2 - no options', options: [], severity: 'med', hint: '' },
    { prompt: 'Q3', options: [{ label: 'b', recommended: true, impact: '' }], severity: 'med', hint: '' },
  ];
  const ans = answerableDecisions(items);
  assert.deepEqual(ans.map((a) => a.id), ['H1', 'H3']); // Q2 is skipped without displacing Q3's positional id
  assert.equal(ans[1].item.prompt, 'Q3');
});

test('DECISION_CAP: items 6-8 are equally answerable (the cap matches what the card displays; never "shown but with no dropdown")', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({
    prompt: `Q${i + 1}`,
    options: [{ label: 'a', recommended: false, impact: '' }],
    severity: 'med',
    hint: '',
  }));
  const ans = answerableDecisions(items);
  assert.equal(ans.length, 8); // all 8 are answerable (not just the first 5)
  assert.equal(ans[5].id, 'H6');
  assert.equal(ans[7].id, 'H8');
});

test('composeDecisionAnswer: per-item choices + a partial prefix for verdict=partial + the global notes; "other" and unanswered are skipped', () => {
  const items = humanAsksToDecisions(
    parseHumanAsks(
      JSON.stringify([
        { id: 'H1', question: 'Where does the refund go?', options: ['Original route', 'Balance'] },
        { id: 'H2', question: 'Accept the risk?', options: ['Accept', 'Do not accept'] },
      ]),
    ),
  );
  const out = composeDecisionAnswer(items, { ask_H1: 'Balance', ask_H2: '__other__', notes: 'add an idempotency unit test' }, 'partial');
  assert.match(out, /Partially accepted/);
  assert.match(out, /H1 \(Where does the refund go\?\): Balance/);
  assert.doesNotMatch(out, /H2/); // choosing "other" is not treated as an option answer; it goes into the notes
  assert.match(out, /Notes: add an idempotency unit test/);
  assert.equal(composeDecisionAnswer(items, {}), ''); // all empty -> empty string (submit falls back to "one more revision")
});
