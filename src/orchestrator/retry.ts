// Classifying a step failure as transient or permanent, scheduling the backoff, and planning which state a
// retry returns to.
// Transient (a timeout, rate limiting, a network blip, a flaky git fetch) -> retry automatically with a
// backoff, and once those are exhausted move to the dead-letter queue. Permanent (a parse failure, a contract
// violation, a permission or configuration problem) -> park immediately and wait for a human.
// It is mostly pure functions so it is easy to unit-test: the worker schedules from it, and actions.retry
// reuses planRetry so a manual retry and an automatic one behave identically.

import { loadConfig } from '../config.ts';
import type { Session } from '../types.ts';
import type { State } from '../statemachine/states.ts';

export type FailureClass = 'transient' | 'permanent';

// Transient signals: infrastructure wobbles that a retry will very likely heal. Everything else is treated as
// **permanent** (safe by default - a permanent classification only costs one extra manual retry, whereas
// misjudging a permanent failure as transient burns tokens repeatedly in a loop). It matches the error strings
// claude, codex and git actually produce, plus the common network and rate-limit codes.
// That includes the exact wording the claude and codex CLIs use when they stuff an API-layer error into the
// stream-json result: "API Error: The socket connection was closed unexpectedly." hits three alternatives at
// once (socket connection / closed unexpectedly / connection was closed).
//
// **This regex matches error *text*, so the wording of the messages it is meant to catch is load-bearing.**
// The two places that deliberately emit a matching phrase say so at the throw site:
// llm/runClaude.ts and llm/runCodex.ts emit "timed out", and gates/repoFreshness.ts emits "fetch failed".
// Rewording either of those without updating this regex would silently reclassify a transient failure as
// permanent - a session would park for a human instead of retrying, and no test would go red.
const TRANSIENT_RE =
  /timed?\s*out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|ENOTFOUND|socket hang up|socket connection|closed unexpectedly|fetch failed|connection error|\b(429|500|502|503|504|529)\b|overloaded|rate.?limit|EPIPE|EAGAIN|EBUSY|temporarily unavailable|connection (?:was )?(?:reset|refused|closed|timed out)/i;

export function classifyError(err: unknown): FailureClass {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_RE.test(msg) ? 'transient' : 'permanent';
}

// The backoff: 30s / 2min / 5min (exponential with a cap), with attempt starting at 1. The ±20% jitter stops
// several sessions retrying in lockstep and hitting the rate limit together.
const BACKOFF_MS = [30_000, 120_000, 300_000];
export function backoffMs(attempt: number, rand: number = Math.random()): number {
  const base = BACKOFF_MS[Math.min(Math.max(attempt, 1) - 1, BACKOFF_MS.length - 1)];
  const jitter = base * 0.2 * (rand * 2 - 1); // ±20%
  return Math.round(base + jitter);
}

export function maxAutoRetries(): number {
  return loadConfig().runtime.retry?.max_auto_retries ?? 3;
}
export function maxReclaims(): number {
  return loadConfig().runtime.retry?.max_reclaims ?? 3;
}

// The retry target state: it turns a parked state back into a runnable one (the same rule `forge retry` uses,
// so automatic and manual retries share one path).
// Returning null means this state has no automatic retry path (WRITE_FAILED, for instance, needs a human GO -
// it must never create issues on its own).
// `fields` carries only the state-related resets, not the retry bookkeeping (whether retry_count and
// dead_letter are cleared is the caller's decision, and differs between an automatic and a manual retry).
export function planRetry(s: Session): { to: State; fields: Partial<Session> } | null {
  if (s.state === 'GATE_A_FAILED') {
    // A failure partway through the adversarial re-review resets in place and continues the adversarial loop
    // (keeping the review draft, the round counter and the codex thread, and never falling back to INTAKE and
    // bothering the PM again).
    // Entering the adversarial phase writes gate_a_adv_round=0 as a marker (worker.afterGateA), so `!= null`
    // also covers the window where the very first codex call failed - no round counted yet and no codex thread
    // started. That window is exactly the hole through which a missed check would fall back to INTAKE.
    if (s.gate_a_adv_round != null || s.gate_a_reviewer_session) {
      return { to: 'GATE_A_ADVERSARIAL', fields: { error: null } };
    }
    // A failed re-review (pending_input is still set) returns to the re-review point without losing the rounds
    // already accumulated; a failure on the first round returns to INTAKE for a full re-run.
    const to: State = s.gate_a_pending_input ? 'GATE_A_REVISION_REQUESTED' : 'INTAKE';
    return { to, fields: { error: null } };
  }
  if (s.state === 'GATE_B_FAILED') {
    const hasDraft = !!s.gate_b_draft_path && (s.gate_b_round ?? 0) > 0;
    if (hasDraft) {
      // A first draft exists and rounds have started -> reset in place and continue the adversarial loop
      // (keeping the round counter and the sessions).
      const to: State = s.gate_b_pending_input ? 'GATE_B_REVISION_REQUESTED' : 'ADVERSARIAL_LOOP';
      return { to, fields: { error: null } };
    }
    // No draft, or no round started -> a clean re-run: clear the old adversarial sessions, round counter,
    // residue and escalated questions (so an old codex thread cannot be resumed against a brand-new draft).
    return {
      to: 'GATE_B_REQUESTED',
      fields: {
        error: null,
        gate_b_reviewer_session: null,
        gate_b_fixer_session: null,
        gate_b_round: null,
        gate_b_pending_input: null,
        gate_b_human_asks: null,
        adversarial_residual: null,
      },
    };
  }
  if (s.state === 'GATE_C_FAILED') {
    // The worktree already exists -> reset in place and continue the implementation loop (keeping the round
    // counter and the session; never re-run setup and collide with a worktree that is already there).
    if (s.worktree_path) {
      const to: State = s.gate_c_pending_input ? 'GATE_C_REVISION_REQUESTED' : 'GATE_C_LOOP';
      return { to, fields: { error: null } };
    }
    // No worktree, or setup failed -> re-run setup cleanly (clearing any half-finished session and round
    // counter).
    return {
      to: 'GATE_C_REQUESTED',
      fields: { error: null, gate_c_fixer_session: null, gate_c_round: null, gate_c_pending_input: null, gate_c_human_asks: null, gate_c_residual: null },
    };
  }
  if (s.state === 'GATE_D_FAILED') {
    // The rollback poison pill has the highest priority: a worktree whose reset was never confirmed must go
    // through recoverPendingRollback at runGateDLoop's entry and be reset for real, and must never slip through
    // to HARDENING (which runs no rollback recovery). On the normal path the poison pill and harden_round never
    // coexist; this is a defensive backstop for the case where an anomaly or old data lets them (Codex, second
    // review, SF). Returning to LOOP or the revision point is what puts it past the recovery gate.
    if (s.gate_d_rollback_to) {
      const to: State = s.gate_d_pending_input ? 'GATE_D_REVISION_REQUESTED' : 'GATE_D_LOOP';
      return { to, fields: { error: null } };
    }
    // Test hardening has already started (harden_round > 0) -> return to GATE_D_HARDENING and continue, rather
    // than to LOOP and burn another codex round for nothing (hardening is idempotent on re-entry: entering
    // HARDENING first resets to the pinned, immutable gate_d_green_sha baseline).
    if ((s.gate_d_harden_round ?? 0) > 0) {
      return { to: 'GATE_D_HARDENING', fields: { error: null } };
    }
    // The PR is open -> reset in place and continue the PR adversarial loop (keeping the round counter and both
    // sides' sessions; with a pending input it returns to the revision point instead).
    if (s.pr_url) {
      const to: State = s.gate_d_pending_input ? 'GATE_D_REVISION_REQUESTED' : 'GATE_D_LOOP';
      return { to, fields: { error: null } };
    }
    // Opening the PR failed, or it was never opened -> return to GATE_D_REQUESTED and open it (the project's
    // create-PR script is idempotent, so it will not create a duplicate).
    return { to: 'GATE_D_REQUESTED', fields: { error: null } };
  }
  return null;
}
