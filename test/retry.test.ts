// Unit tests: the pure functions behind the step-failure retry machinery (classification, backoff, and
// planning the retry target state).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, backoffMs, planRetry } from '../src/orchestrator/retry.ts';
import type { Session } from '../src/types.ts';

// The fixtures below are the messages the code **actually emits today**, not invented ones. Two of them are
// load-bearing and are marked as such at their throw sites:
//   - 'claude timed out' / 'codex timed out'  (src/llm/runClaude.ts, src/llm/runCodex.ts)
//   - 'git fetch failed for the source of truth: ...'  (src/gates/repoFreshness.ts)
// Rewording either without updating TRANSIENT_RE silently reclassifies a transient failure as permanent - the
// session parks for a human instead of retrying, with no other symptom. These cases are what catch that.
test('classifyError: transient signals (timeouts, rate limits, network, fetch) are classified transient', () => {
  for (const m of [
    'claude timed out',
    'codex timed out',
    'Gate A claude failed: claude timed out',
    'git fetch failed for the source of truth: demo (still failing after retries)',
    'claude exit code 1: Error: server overloaded (529)',
    'fetch failed: ECONNRESET',
    'request failed with status 429',
    'upstream returned 503',
    'getaddrinfo EAI_AGAIN api.anthropic.com',
    'socket hang up',
    // The claude CLI stuffs API-layer network errors into the stream-json result and exits 1 -> these must be
    // recognised as transient and retried automatically (they were once misjudged as permanent).
    'claude exit code 1: API Error: The socket connection was closed unexpectedly.',
    'Gate A claude failed: claude exit code 1: API Error: Connection error.',
    'fetch failed',
  ]) {
    assert.equal(classifyError(new Error(m)), 'transient', m);
  }
});

test('classifyError: semantic, permission and configuration failures are classified permanent (safe by default)', () => {
  for (const m of [
    'Gate A output failed to parse',
    'the Gate B first draft failed',
    'the adversarial review failed',
    'the output does not match the contract: open_questions: Required',
    'codex exit code 2: invalid credentials',
    'issue_specs is empty, so there is nothing to create',
    'Gate B revision: the revision output failed to parse',
  ]) {
    assert.equal(classifyError(new Error(m)), 'permanent', m);
  }
});

test('backoffMs: exponential growth, capped, with jitter inside ±20%', () => {
  // rand = 0.5 -> no jitter, so it returns the base value
  assert.equal(backoffMs(1, 0.5), 30_000);
  assert.equal(backoffMs(2, 0.5), 120_000);
  assert.equal(backoffMs(3, 0.5), 300_000);
  assert.equal(backoffMs(4, 0.5), 300_000); // beyond the last step -> capped
  assert.equal(backoffMs(0, 0.5), 30_000); // attempt < 1 falls back to the first step
  // the jitter bounds
  assert.equal(backoffMs(1, 0), 24_000); // -20%
  assert.equal(backoffMs(1, 1), 36_000); // +20%
});

function mk(overrides: Partial<Session>): Session {
  return { state: 'GATE_A_FAILED', ...overrides } as Session;
}

test('planRetry: GATE_A_FAILED with a pending_input returns to the re-review point; otherwise to INTAKE', () => {
  assert.deepEqual(planRetry(mk({ state: 'GATE_A_FAILED' })), { to: 'INTAKE', fields: { error: null } });
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_A_FAILED', gate_a_pending_input: "the PM's answer" })),
    { to: 'GATE_A_REVISION_REQUESTED', fields: { error: null } },
  );
});

test('planRetry: a Gate A adversarial failure continues the adversarial loop in place (including when the very first codex call failed: adv_round=0 is set but no codex thread has started)', () => {
  // A round or a codex thread has started: continue the adversarial loop (never fall back to INTAKE)
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_A_FAILED', gate_a_adv_round: 1 })),
    { to: 'GATE_A_ADVERSARIAL', fields: { error: null } },
  );
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_A_FAILED', gate_a_reviewer_session: 'codex-x' })),
    { to: 'GATE_A_ADVERSARIAL', fields: { error: null } },
  );
  // The key regression: the very first codex call failed (the worker wrote adv_round=0 on entering the
  // adversarial phase, with no round counted and no codex thread started) -> it still returns to the
  // adversarial loop, rather than a `> 0` check missing it and falling back to INTAKE to re-run all of Gate A
  // and bother the PM again. Even a stray pending_input does not outrank continuing the adversarial loop.
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_A_FAILED', gate_a_adv_round: 0 })),
    { to: 'GATE_A_ADVERSARIAL', fields: { error: null } },
  );
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_A_FAILED', gate_a_adv_round: 0, gate_a_pending_input: "the PM's stale answer" })),
    { to: 'GATE_A_ADVERSARIAL', fields: { error: null } },
  );
});

test('planRetry: GATE_B_FAILED with a draft and rounds started continues the adversarial loop (or the revision point when a pending input is set)', () => {
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_B_FAILED', gate_b_draft_path: '/tmp/d.json', gate_b_round: 2 })),
    { to: 'ADVERSARIAL_LOOP', fields: { error: null } },
  );
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_B_FAILED', gate_b_draft_path: '/tmp/d.json', gate_b_round: 2, gate_b_pending_input: "the owner's decision" })),
    { to: 'GATE_B_REVISION_REQUESTED', fields: { error: null } },
  );
});

test('planRetry: GATE_B_FAILED with no draft or no round started re-runs cleanly and clears the old adversarial state', () => {
  const p = planRetry(mk({ state: 'GATE_B_FAILED', gate_b_round: 0 }));
  assert.equal(p?.to, 'GATE_B_REQUESTED');
  assert.equal(p?.fields.gate_b_reviewer_session, null);
  assert.equal(p?.fields.gate_b_fixer_session, null);
  assert.equal(p?.fields.adversarial_residual, null);
});

test('planRetry: GATE_C_FAILED with a worktree continues the implementation loop (or the revision point when a pending input is set); with no worktree it re-runs setup cleanly', () => {
  // With a worktree: continue the implement/CI loop in place (never re-run setup and collide with the existing
  // worktree).
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_C_FAILED', worktree_path: '/wt/x' })),
    { to: 'GATE_C_LOOP', fields: { error: null } },
  );
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_C_FAILED', worktree_path: '/wt/x', gate_c_pending_input: "the owner's decision" })),
    { to: 'GATE_C_REVISION_REQUESTED', fields: { error: null } },
  );
  // With no worktree (setup failed): re-run setup cleanly, clearing the half-finished session, round counter
  // and residue.
  const clean = planRetry(mk({ state: 'GATE_C_FAILED' }));
  assert.equal(clean?.to, 'GATE_C_REQUESTED');
  assert.equal(clean?.fields.gate_c_fixer_session, null);
  assert.equal(clean?.fields.gate_c_round, null);
  assert.equal(clean?.fields.gate_c_residual, null);
});

test('planRetry: GATE_D_FAILED with a pr_url continues the PR adversarial loop (or the revision point when a pending input is set); with no pr_url it returns to open the PR', () => {
  // The PR is open: continue the codex-reviews / claude-revises loop in place (keeping the round counter and
  // both sides' sessions).
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_D_FAILED', pr_url: 'https://github.com/x/y/pull/1' })),
    { to: 'GATE_D_LOOP', fields: { error: null } },
  );
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_D_FAILED', pr_url: 'https://github.com/x/y/pull/1', gate_d_pending_input: "the owner's decision" })),
    { to: 'GATE_D_REVISION_REQUESTED', fields: { error: null } },
  );
  // Opening the PR failed or it was never opened: return to GATE_D_REQUESTED to open it (the project's
  // create-PR script is idempotent).
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_D_FAILED' })),
    { to: 'GATE_D_REQUESTED', fields: { error: null } },
  );
  // The failed-rollback poison pill (gate_d_rollback_to) must survive the retry: planRetry only resets `error`
  // and never clears the pill - otherwise, once it is sent back to GATE_D_LOOP, recoverPendingRollback has
  // nothing to gate on and a red or dirty HEAD would enter review-first (Codex, third review, blocker).
  const r = planRetry(mk({ state: 'GATE_D_FAILED', pr_url: 'https://github.com/x/y/pull/1', gate_d_rollback_to: 'GREENSHA' }));
  assert.equal(r!.to, 'GATE_D_LOOP');
  assert.equal('gate_d_rollback_to' in r!.fields, false); // not among the reset fields -> the pill survives
  // Test hardening has started (harden_round > 0) -> return to GATE_D_HARDENING and continue, never to LOOP to
  // burn another codex round for nothing (this outranks pr_url -> LOOP).
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_D_FAILED', pr_url: 'https://github.com/x/y/pull/1', gate_d_harden_round: 1 })),
    { to: 'GATE_D_HARDENING', fields: { error: null } },
  );
  // The rollback poison pill has the highest priority: even when harden_round is also set (an anomalous
  // coexistence), it must return to LOOP and be forced through recoverPendingRollback's confirmed reset, never
  // slipping through to HARDENING (which runs no rollback recovery). The pill survives (it is not among the
  // reset fields).
  const rb = planRetry(mk({ state: 'GATE_D_FAILED', pr_url: 'https://github.com/x/y/pull/1', gate_d_rollback_to: 'G', gate_d_harden_round: 1 }));
  assert.equal(rb!.to, 'GATE_D_LOOP');
  assert.equal('gate_d_rollback_to' in rb!.fields, false);
});

test('planRetry: states with no retry path (WRITE_FAILED, or a running state) -> null', () => {
  assert.equal(planRetry(mk({ state: 'WRITE_FAILED' })), null);
  assert.equal(planRetry(mk({ state: 'AWAITING_GO' })), null);
});
