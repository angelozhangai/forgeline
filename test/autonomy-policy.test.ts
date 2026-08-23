// Unit tests for the graduated autonomy ladder (the pure autonomyPolicy). They pin which states may run
// automatically and the minimum level each needs, plus the red line that a dangerous or judgement-based state
// never runs automatically at any level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoActionFor, AUTONOMY_GATES, AUTONOMY_MAX_LEVEL } from '../src/statemachine/autonomyPolicy.ts';

test('the ladder: each of the four authorised pause points fires only at its own minimum level, and not below it', () => {
  // CONFIRMED -> requestGateB (L1)
  assert.equal(autoActionFor('CONFIRMED', 0), null);
  assert.equal(autoActionFor('CONFIRMED', 1), 'requestGateB');
  // AWAITING_GO -> go (L2)
  assert.equal(autoActionFor('AWAITING_GO', 1), null);
  assert.equal(autoActionFor('AWAITING_GO', 2), 'go');
  // DONE -> requestGateC (L3)
  assert.equal(autoActionFor('DONE', 2), null);
  assert.equal(autoActionFor('DONE', 3), 'requestGateC');
  // AWAITING_GATE_D -> requestReviewPr (L4)
  assert.equal(autoActionFor('AWAITING_GATE_D', 3), null);
  assert.equal(autoActionFor('AWAITING_GATE_D', 4), 'requestReviewPr');
});

test('monotonic: a higher level includes the lower levels\' actions, so at L4 all four authorised points fire their own', () => {
  assert.equal(autoActionFor('CONFIRMED', 4), 'requestGateB');
  assert.equal(autoActionFor('AWAITING_GO', 4), 'go');
  assert.equal(autoActionFor('DONE', 4), 'requestGateC');
  assert.equal(autoActionFor('AWAITING_GATE_D', 4), 'requestReviewPr');
});

test('the red line: a dangerous, judgement-based or failed state never runs automatically at any level, including levels far above the cap', () => {
  const huge = 99;
  // Red line #1: never merge automatically.
  assert.equal(autoActionFor('AWAITING_HUMAN_MERGE', huge), null);
  // Red line #2: a deterministic gate is never skippable -- CI that is not green can only be fixed.
  assert.equal(autoActionFor('GATE_C_STALLED', huge), null);
  // States that call for judgement -- a person has to decide, and nothing decides for them.
  for (const st of ['GATE_A_STALLED', 'GATE_B_STALLED', 'GATE_D_STALLED'] as const) {
    assert.equal(autoActionFor(st, huge), null, st);
  }
  // Escalated states waiting on a human answer.
  for (const st of ['AWAITING_PM_CONFIRM', 'AWAITING_GATE_B_INPUT', 'AWAITING_GATE_C_INPUT', 'AWAITING_GATE_D_INPUT'] as const) {
    assert.equal(autoActionFor(st, huge), null, st);
  }
  // Failed and terminal states.
  for (const st of ['GATE_A_FAILED', 'GATE_B_FAILED', 'GATE_C_FAILED', 'GATE_D_FAILED', 'GO_DENIED', 'WRITE_FAILED', 'SHIPPED'] as const) {
    assert.equal(autoActionFor(st, huge), null, st);
  }
  // States already running -- the poller has them, so autonomy has nothing to add.
  for (const st of ['GATE_A_RUNNING', 'GATE_C_LOOP', 'GATE_D_HARDENING'] as const) {
    assert.equal(autoActionFor(st, huge), null, st);
  }
});

test('AUTONOMY_GATES is exactly the four authorised pause points, and the cap is 4', () => {
  assert.deepEqual([...AUTONOMY_GATES].sort(), ['AWAITING_GATE_D', 'AWAITING_GO', 'CONFIRMED', 'DONE']);
  assert.equal(AUTONOMY_MAX_LEVEL, 4);
});
