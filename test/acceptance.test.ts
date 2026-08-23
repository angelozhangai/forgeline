import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceMarkdown, lintAcceptance } from '../src/util/acceptance.ts';
import { GateBSchema } from '../src/gates/envelopes.ts';
import type { Acceptance } from '../src/gates/envelopes.ts';

test('acceptanceMarkdown: empty / undefined -> an empty string', () => {
  assert.equal(acceptanceMarkdown(undefined), '');
  assert.equal(acceptanceMarkdown({ contracts: [], scenarios: [] }), '');
  // Items that are nothing but whitespace count as empty too
  assert.equal(
    acceptanceMarkdown({ contracts: [{ repo: 'C', surface: '  ' }], scenarios: [{ id: 'AC1', repo: 'C', gherkin: '' }] }),
    '',
  );
});

const acc: Acceptance = {
  contracts: [
    { repo: 'C', surface: 'POST /api/v1/pay/refund -> 200|409' },
    { repo: '', surface: 'global: every amount is denominated in cents' },
  ],
  scenarios: [
    { id: 'AC1', repo: 'C', gherkin: 'Given a paid order\nWhen it is refunded\nThen refunded' },
    { id: 'AC2', repo: 'U', gherkin: 'Given the front end\nWhen a refund is requested\nThen a confirmation is shown' },
  ],
};

test('acceptanceMarkdown: filtered by repo, keeping the items with no repo set and excluding other repos', () => {
  const md = acceptanceMarkdown(acc, 'C');
  assert.equal(md.includes('POST /api/v1/pay/refund'), true);
  assert.equal(md.includes('global: every amount is denominated in cents'), true); // the unscoped item is included
  assert.equal(md.includes('AC1'), true);
  assert.equal(md.includes('AC2'), false); // a scenario for repo U does not go into repo C's issue
  assert.equal(md.includes('```gherkin'), true);
  assert.equal(md.includes('outer ring'), true);
});

test('acceptanceMarkdown: no repo given -> take everything (for the Epic and the technical-design document)', () => {
  const md = acceptanceMarkdown(acc);
  assert.equal(md.includes('AC1'), true);
  assert.equal(md.includes('AC2'), true);
});

// ---- the outer-ring acceptance lint (the gate before GO) ----
const good = GateBSchema.parse({
  acceptance: {
    contracts: [{ repo: 'C', surface: 'POST /api/v1/pay/refund -> 200|409' }],
    scenarios: [{ id: 'AC1', repo: 'C', gherkin: 'Given a paid order\nWhen it is refunded with an idempotency key\nThen a refund_id is returned' }],
  },
  issue_specs: [{ repo: 'C', title: 'feat(pay): refunds' }],
});

test('lintAcceptance: a well-formed outer ring -> ok', () => {
  const r = lintAcceptance(good);
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
});

test('lintAcceptance: an empty acceptance -> no scenario + no contract', () => {
  const r = lintAcceptance(GateBSchema.parse({ issue_specs: [{ repo: 'C', title: 't' }] }));
  assert.equal(r.ok, false);
  assert.equal(r.problems.some((p) => p.includes('has no scenario')), true);
  assert.equal(r.problems.some((p) => p.includes('has no contract')), true);
});

test('lintAcceptance: an imperative scenario (clicking a button) -> blocked', () => {
  const env = GateBSchema.parse({
    acceptance: {
      contracts: [{ repo: 'C', surface: 'POST /x' }],
      scenarios: [{ id: 'AC1', repo: 'C', gherkin: 'Given the page\nWhen I click the submit button\nThen it succeeds' }],
    },
    issue_specs: [{ repo: 'C', title: 't' }],
  });
  const r = lintAcceptance(env);
  assert.equal(r.ok, false);
  assert.equal(r.problems.some((p) => p.includes('imperative action')), true);
});

// Source is English, input is not: the scenarios being linted are generated from the requirement document,
// which may arrive in any language. This pins the non-English half of IMPERATIVE — without it, dropping those
// alternatives would silently stop the lint catching click paths for every non-English PRD, and no test would
// notice. The fixture is built from code points rather than written as literal characters (see
// test/english-only.test.ts).
test('lintAcceptance: an imperative scenario written in another language -> blocked just the same', () => {
  const click = String.fromCodePoint(0x70b9, 0x51fb); // "click"
  const env = GateBSchema.parse({
    acceptance: {
      contracts: [{ repo: 'C', surface: 'POST /x' }],
      scenarios: [{ id: 'AC1', repo: 'C', gherkin: `Given the page\nWhen ${click} submit\nThen it succeeds` }],
    },
    issue_specs: [{ repo: 'C', title: 't' }],
  });
  assert.equal(lintAcceptance(env).problems.some((p) => p.includes('imperative action')), true);
});

test('lintAcceptance: a scenario with no Then -> structurally incomplete', () => {
  const env = GateBSchema.parse({
    acceptance: {
      contracts: [{ repo: 'C', surface: 'POST /x' }],
      scenarios: [{ id: 'AC1', repo: 'C', gherkin: 'Given an order\nWhen it is refunded' }],
    },
    issue_specs: [{ repo: 'C', title: 't' }],
  });
  assert.equal(lintAcceptance(env).problems.some((p) => p.includes('structurally incomplete')), true);
});

test('lintAcceptance: a repo with an issue but no outer-ring coverage -> blocked; an unscoped item exempts it', () => {
  const env = GateBSchema.parse({
    acceptance: {
      contracts: [{ repo: 'C', surface: 'POST /x' }],
      scenarios: [{ id: 'AC1', repo: 'C', gherkin: 'Given a\nWhen b\nThen c' }],
    },
    issue_specs: [{ repo: 'C', title: 't1' }, { repo: 'U', title: 't2' }], // U is not covered
  });
  assert.equal(lintAcceptance(env).problems.some((p) => p.includes('repo U')), true);

  const env2 = GateBSchema.parse({
    acceptance: {
      contracts: [{ repo: '', surface: 'a general constraint' }], // an unscoped item covers every repo
      scenarios: [{ id: 'AC1', repo: '', gherkin: 'Given a\nWhen b\nThen c' }],
    },
    issue_specs: [{ repo: 'C', title: 't1' }, { repo: 'U', title: 't2' }],
  });
  assert.equal(lintAcceptance(env2).ok, true);
});
