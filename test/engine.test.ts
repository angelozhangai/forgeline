import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition } from '../src/statemachine/engine.ts';

// The gate-lifecycle FSM is core business: legal transitions pass, illegal ones are refused, and parked
// states can be re-run.
test('the ordinary forward path is legal', () => {
  for (const [a, b] of [
    ['INTAKE', 'GATE_A_RUNNING'],
    ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM'],
    ['AWAITING_PM_CONFIRM', 'CONFIRMED'],
    ['CONFIRMED', 'GATE_B_REQUESTED'],
    ['GATE_B_REQUESTED', 'GATE_B_RUNNING'],
    ['GATE_B_RUNNING', 'ADVERSARIAL_LOOP'],
    ['ADVERSARIAL_LOOP', 'AWAITING_GO'],
    ['AWAITING_GO', 'WRITING'],
    ['WRITING', 'DONE'],
  ] as const) {
    assert.ok(canTransition(a, b), `${a}->${b} should be legal`);
  }
});

test('gate A: the multi-round product loop is legal', () => {
  for (const [a, b] of [
    ['AWAITING_PM_CONFIRM', 'GATE_A_REVISION_REQUESTED'], // product answered -> re-review
    ['GATE_A_REVISION_REQUESTED', 'GATE_A_RUNNING'], // the worker starts the re-review
    ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM'], // still open questions -> next round
    ['GATE_A_RUNNING', 'CONFIRMED'], // nothing left open -> review finished
    ['GATE_A_RUNNING', 'GATE_A_STALLED'], // round limit reached -> park
    ['GATE_A_STALLED', 'CONFIRMED'], // the maintainer forces it closed
    ['GATE_A_STALLED', 'GATE_A_REVISION_REQUESTED'], // the maintainer adds input and runs another round
    ['GATE_A_REVISION_REQUESTED', 'GATE_A_FAILED'], // the re-review itself failed -> park
    ['GATE_A_FAILED', 'GATE_A_REVISION_REQUESTED'], // retry returns to the re-review point without losing the round
  ] as const) {
    assert.ok(canTransition(a, b), `${a}->${b} should be legal`);
  }
});

test('gate A: the codex adversarial pass is legal (claude re-review has no open questions -> adversarial -> confirmed)', () => {
  for (const [a, b] of [
    ['GATE_A_RUNNING', 'GATE_A_ADVERSARIAL'], // no open questions left -> adversarial (no longer straight to CONFIRMED)
    ['GATE_A_ADVERSARIAL', 'GATE_A_ADVERSARIAL'], // per-tick limit -> self-transition to carry on
    ['GATE_A_ADVERSARIAL', 'CONFIRMED'], // codex says LGTM -> confirmed, on to gate B
    ['GATE_A_ADVERSARIAL', 'GATE_A_STALLED'], // limit reached -> park for the maintainer to rule on
    ['GATE_A_ADVERSARIAL', 'GATE_A_FAILED'], // the call failed -> park
    ['GATE_A_FAILED', 'GATE_A_ADVERSARIAL'], // orphan recovery -> resume the adversarial pass in place
    ['GATE_A_ADVERSARIAL', 'AWAITING_PM_CONFIRM'], // the pass found a question product never answered -> back to product (never auto-confirm)
  ] as const) {
    assert.ok(canTransition(a, b), `${a}->${b} should be legal`);
  }
  // Gate A's adversarial pass does not escalate to a human in the loop (an unclear PRD goes round the product
  // loop), so there is no ->AWAITING_GATE_B_INPUT edge: a missed question goes ->AWAITING_PM_CONFIRM.
  assert.equal(canTransition('GATE_A_ADVERSARIAL', 'AWAITING_GATE_B_INPUT'), false);
  assert.equal(canTransition('GATE_A_ADVERSARIAL', 'GATE_B_REQUESTED'), false); // must go through CONFIRMED
});

test('gate B: the multi-round codex-reviews/claude-revises human-in-the-loop cycle is legal', () => {
  for (const [a, b] of [
    ['ADVERSARIAL_LOOP', 'ADVERSARIAL_LOOP'], // per-tick limit -> self-transition to carry on
    ['ADVERSARIAL_LOOP', 'AWAITING_GO'], // codex is clean -> release
    ['ADVERSARIAL_LOOP', 'AWAITING_GATE_B_INPUT'], // claude escalates -> wait for the maintainer
    ['ADVERSARIAL_LOOP', 'GATE_B_STALLED'], // limit reached -> park for a ruling
    ['AWAITING_GATE_B_INPUT', 'GATE_B_REVISION_REQUESTED'], // the maintainer answered -> keep revising
    ['GATE_B_REVISION_REQUESTED', 'ADVERSARIAL_LOOP'], // resume revising -> back into the loop
    ['GATE_B_REVISION_REQUESTED', 'GATE_B_FAILED'], // the revision itself failed -> park
    ['GATE_B_STALLED', 'AWAITING_GO'], // the maintainer forces the project through
    ['GATE_B_STALLED', 'GATE_B_REVISION_REQUESTED'], // the maintainer asks for one more round
  ] as const) {
    assert.ok(canTransition(a, b), `${a}->${b} should be legal`);
  }
});

test('gate B: orphan recovery has two legal hops -- FAILED back to where it stopped', () => {
  assert.ok(canTransition('GATE_B_FAILED', 'ADVERSARIAL_LOOP')); // a draft exists -> carry on in place
  assert.ok(canTransition('GATE_B_FAILED', 'GATE_B_REVISION_REQUESTED')); // pending_input exists -> the revision point
});

test('gate B: the human-in-the-loop pause points cannot be skipped', () => {
  assert.equal(canTransition('AWAITING_GATE_B_INPUT', 'AWAITING_GO'), false); // must go through the revision
  assert.equal(canTransition('ADVERSARIAL_LOOP', 'DONE'), false);
  assert.equal(canTransition('GATE_B_STALLED', 'DONE'), false);
});

test('product cannot settle it alone: AWAITING_PM_CONFIRM->CONFIRMED is the maintainer only (the FSM allows it, the permission lives in actions)', () => {
  // At the FSM layer AWAITING_PM_CONFIRM->CONFIRMED is legal (that is how the maintainer forces it closed),
  // but the product card goes ->GATE_A_REVISION_REQUESTED.
  assert.ok(canTransition('AWAITING_PM_CONFIRM', 'CONFIRMED'));
  assert.equal(canTransition('GATE_A_STALLED', 'GATE_B_REQUESTED'), false); // a parked state cannot skip the confirmation
});

test('skipping ahead, or jumping about, is illegal', () => {
  assert.equal(canTransition('INTAKE', 'DONE'), false);
  assert.equal(canTransition('INTAKE', 'AWAITING_GO'), false);
  assert.equal(canTransition('AWAITING_PM_CONFIRM', 'WRITING'), false);
  assert.equal(canTransition('DONE', 'WRITING'), false); // a terminal state has no way out
});

test('the legal two-hop used by orphan self-healing: RUNNING->FAILED->the re-run point', () => {
  assert.ok(canTransition('GATE_A_RUNNING', 'GATE_A_FAILED'));
  assert.ok(canTransition('GATE_A_FAILED', 'INTAKE'));
  assert.ok(canTransition('GATE_B_RUNNING', 'GATE_B_FAILED'));
  assert.ok(canTransition('ADVERSARIAL_LOOP', 'GATE_B_FAILED'));
  assert.ok(canTransition('GATE_B_FAILED', 'GATE_B_REQUESTED'));
});

test('the re-run edges out of parked states, plus the go-denied loop', () => {
  assert.ok(canTransition('GO_DENIED', 'AWAITING_GO'));
  assert.ok(canTransition('WRITE_FAILED', 'WRITING'));
  assert.ok(canTransition('AWAITING_GO', 'GO_DENIED'));
});

test('self-transitions are allowed (idempotent patches / the adversarial loop turning in place)', () => {
  assert.ok(canTransition('ADVERSARIAL_LOOP', 'ADVERSARIAL_LOOP'));
  assert.ok(canTransition('INTAKE', 'INTAKE'));
});

// -- Downstream gate C: the implement/CI loop --
test('gate C: the implement/CI loop is legal', () => {
  for (const [a, b] of [
    ['DONE', 'GATE_C_REQUESTED'], // the chained entry (a standalone bare issue starts straight at GATE_C_REQUESTED)
    ['GATE_C_REQUESTED', 'GATE_C_RUNNING'],
    ['GATE_C_RUNNING', 'GATE_C_LOOP'],
    ['GATE_C_LOOP', 'GATE_C_LOOP'], // per-tick limit -> self-transition to carry on
    ['GATE_C_LOOP', 'AWAITING_GATE_D'], // CI green -> wait to open the PR
    ['GATE_C_LOOP', 'AWAITING_GATE_C_INPUT'], // claude escalated needs_human
    ['GATE_C_LOOP', 'GATE_C_STALLED'], // limit reached and still not green -> a ruling
    ['AWAITING_GATE_C_INPUT', 'GATE_C_REVISION_REQUESTED'], // the maintainer answered -> carry on
    ['GATE_C_STALLED', 'GATE_C_REVISION_REQUESTED'], // the maintainer supplies input for one more round (the only way out)
    ['GATE_C_REVISION_REQUESTED', 'GATE_C_LOOP'],
    ['GATE_C_FAILED', 'GATE_C_LOOP'], // orphan / backoff recovery (a worktree exists, carry on)
    ['GATE_C_FAILED', 'GATE_C_REQUESTED'], // a clean re-setup
  ] as const) {
    assert.ok(canTransition(a, b), `${a}->${b} should be legal`);
  }
});

test('red line #3: a stalled gate C (deterministic CI not green) can never be pushed by hand into opening a PR or past gate D', () => {
  // A gate C stall means CI or acceptance is not green -- a deterministic gate failed. The only way out is
  // another round of revision; forcing it forward is never allowed (unlike a gate D stall).
  assert.equal(canTransition('GATE_C_STALLED', 'AWAITING_GATE_D'), false);
  assert.equal(canTransition('GATE_C_STALLED', 'GATE_D_REQUESTED'), false);
  assert.equal(canTransition('GATE_C_LOOP', 'AWAITING_HUMAN_MERGE'), false); // cannot skip gate D and head straight for the merge
  assert.ok(canTransition('GATE_C_STALLED', 'GATE_C_REVISION_REQUESTED')); // the one legal way out
});

// -- Downstream gate D: adversarial PR review + test hardening + a human merge --
test('gate D: adversarial PR review, hardening and the human merge are legal', () => {
  for (const [a, b] of [
    ['AWAITING_GATE_D', 'GATE_D_REQUESTED'], // someone with the permission triggers the PR
    ['GATE_D_REQUESTED', 'GATE_D_LOOP'],
    ['GATE_D_LOOP', 'GATE_D_LOOP'],
    ['GATE_D_LOOP', 'GATE_D_HARDENING'], // codex says LGTM -> add the inner-loop tests
    ['GATE_D_LOOP', 'AWAITING_GATE_D_INPUT'],
    ['GATE_D_LOOP', 'GATE_D_STALLED'],
    ['AWAITING_GATE_D_INPUT', 'GATE_D_REVISION_REQUESTED'],
    ['GATE_D_REVISION_REQUESTED', 'GATE_D_LOOP'],
    ['GATE_D_HARDENING', 'AWAITING_HUMAN_MERGE'],
    ['AWAITING_HUMAN_MERGE', 'SHIPPED'], // forge merged (a human confirms it landed)
    ['AWAITING_HUMAN_MERGE', 'GATE_D_REVISION_REQUESTED'], // something to fix turned up before the merge -> back to revising
  ] as const) {
    assert.ok(canTransition(a, b), `${a}->${b} should be legal`);
  }
  // A gate D stall is codex disagreeing on judgement, and gate C has already established that CI is green,
  // so the maintainer may force it forward to the human merge -- unlike gate C's deterministic stall.
  assert.ok(canTransition('GATE_D_STALLED', 'AWAITING_HUMAN_MERGE'));
  assert.ok(canTransition('GATE_D_STALLED', 'GATE_D_REVISION_REQUESTED'));
});

test('red line #2: never merge automatically, never skip hardening; SHIPPED is terminal', () => {
  assert.equal(canTransition('GATE_D_LOOP', 'AWAITING_HUMAN_MERGE'), false); // must go through hardening
  assert.equal(canTransition('GATE_D_LOOP', 'SHIPPED'), false); // never merge automatically
  assert.equal(canTransition('GATE_D_HARDENING', 'SHIPPED'), false); // even after hardening the merge is still a human's
  for (const t of ['GATE_C_REQUESTED', 'GATE_D_REQUESTED', 'DONE', 'AWAITING_HUMAN_MERGE'] as const) {
    assert.equal(canTransition('SHIPPED', t), false, `SHIPPED->${t} should be illegal (terminal state)`);
  }
});
