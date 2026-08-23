// How the cost view aggregates: what costRows and costSummary count -- gates A, B, C and D totalled,
// bucketed by state, and the withCost tally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costRows, costSummary, formatCost } from '../src/cost.ts';
import type { Session } from '../src/types.ts';

const s = (p: Partial<Session>): Session =>
  ({
    id: 'x', ref_num: null, slug: 'sl', state: 'DONE', size: null,
    gate_a_cost_usd: null, gate_b_cost_usd: null, gate_c_cost_usd: null, gate_d_cost_usd: null,
    assignee: null, updated_at: 0, ...p,
  } as unknown as Session);

test('costRows: the total is gates A + B + C + D, a missing cost counts as 0, and ref is either REQ-N or the id prefix', () => {
  const rows = costRows([
    s({ id: 'a', ref_num: 7, gate_a_cost_usd: 1.5, gate_b_cost_usd: 2.0, gate_c_cost_usd: 4.0, gate_d_cost_usd: 0.5 }),
    s({ id: 'bbbbbbbbbb', ref_num: null }),
  ]);
  assert.equal(rows[0].ref, 'REQ-7');
  assert.equal(rows[0].gateC, 4.0);
  assert.equal(rows[0].gateD, 0.5);
  assert.equal(rows[0].total, 8.0); // 1.5 + 2.0 + 4.0 + 0.5
  assert.equal(rows[1].ref, 'bbbbbbbb'); // the first 8 characters of the id
  assert.equal(rows[1].total, 0);
});

test('costSummary: the total, the per-gate breakdown including gates C and D, the buckets by state, and withCost', () => {
  const rows = costRows([
    s({ ref_num: 1, state: 'DONE', gate_a_cost_usd: 1, gate_b_cost_usd: 3, gate_c_cost_usd: 5, gate_d_cost_usd: 2 }),
    s({ ref_num: 2, state: 'DONE', gate_a_cost_usd: 0.5 }),
    s({ ref_num: 3, state: 'AWAITING_GO' }),
  ]);
  const sum = costSummary(rows);
  assert.equal(sum.total, 11.5);
  assert.equal(sum.gateA, 1.5);
  assert.equal(sum.gateB, 3);
  assert.equal(sum.gateC, 5);
  assert.equal(sum.gateD, 2);
  assert.equal(sum.count, 3);
  assert.equal(sum.withCost, 2); // the third row costs 0 and is not counted
  assert.equal(sum.byState[0].state, 'DONE'); // the most expensive bucket comes first
  assert.equal(sum.byState[0].usd, 11.5);
});

test('formatCost: empty gives a placeholder; non-empty carries the total row broken out across all four gates, plus the management note', () => {
  assert.equal(formatCost([], costSummary([])), '(no sessions)');
  const rows = costRows([s({ ref_num: 1, gate_a_cost_usd: 1, gate_b_cost_usd: 0, gate_c_cost_usd: 2, gate_d_cost_usd: 0 })]);
  const txt = formatCost(rows, costSummary(rows));
  assert.match(txt, /Total \$3\.0000/);
  assert.match(txt, /\$2\.0000/); // the downstream breakdown is visible
  assert.match(txt, /Gate D \$0\.0000/);
  assert.match(txt, /private, management-facing/);
});
