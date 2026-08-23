import type { State } from './states.ts';

// The legal transition table. Self-transitions (from === to) are allowed, which is what lets
// ADVERSARIAL_LOOP loop and makes patches idempotent.
const ALLOWED: Record<State, State[]> = {
  INTAKE: ['GATE_A_RUNNING', 'GATE_A_FAILED'],
  // After Gate A's first round or a re-review: questions remain -> wait for the PM; nothing left ->
  // go to the codex adversarial pass; cap reached -> park for arbitration; failure -> park.
  // (CONFIRMED is kept: it is the target when the maintainer forces an end from
  // AWAITING_PM_CONFIRM/STALLED, and the FSM layer allows it.)
  GATE_A_RUNNING: ['AWAITING_PM_CONFIRM', 'GATE_A_ADVERSARIAL', 'CONFIRMED', 'GATE_A_STALLED', 'GATE_A_FAILED'],
  // The PM answered -> go to the re-review point; CONFIRMED is reserved for the maintainer forcing an end.
  AWAITING_PM_CONFIRM: ['GATE_A_REVISION_REQUESTED', 'CONFIRMED'],
  GATE_A_REVISION_REQUESTED: ['GATE_A_RUNNING', 'GATE_A_FAILED'],
  // Gate A adversarial: codex says LGTM with no new open questions -> confirm; the adversarial pass
  // surfaced a question the PM never answered -> bounce back to the PM; cap reached -> park for
  // arbitration; per-tick cap -> self-transition to continue; failure -> park.
  // It never escalates to a human in the loop (an uncertain PRD goes through the PM loop).
  GATE_A_ADVERSARIAL: ['GATE_A_ADVERSARIAL', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_A_STALLED', 'GATE_A_FAILED'],
  // Maintainer arbitration: force it through, or supply input and run another round.
  GATE_A_STALLED: ['CONFIRMED', 'GATE_A_REVISION_REQUESTED'],
  CONFIRMED: ['GATE_B_REQUESTED'],
  GATE_B_REQUESTED: ['GATE_B_RUNNING', 'GATE_B_FAILED'],
  GATE_B_RUNNING: ['ADVERSARIAL_LOOP', 'GATE_B_FAILED'],
  // Adversarial loop: clean -> GO; claude escalated -> await the maintainer; cap reached -> park for
  // arbitration; per-tick cap -> self-transition to continue; failure -> park.
  ADVERSARIAL_LOOP: ['ADVERSARIAL_LOOP', 'AWAITING_GO', 'AWAITING_GATE_B_INPUT', 'GATE_B_STALLED', 'GATE_B_FAILED'],
  // The maintainer answered the escalated questions -> go to the resume point.
  AWAITING_GATE_B_INPUT: ['GATE_B_REVISION_REQUESTED'],
  // Resume after the maintainer answered -> back into the loop for another review; failure -> park.
  GATE_B_REVISION_REQUESTED: ['ADVERSARIAL_LOOP', 'GATE_B_FAILED'],
  // Maintainer arbitration: force the requirement through, or one more revision.
  GATE_B_STALLED: ['AWAITING_GO', 'GATE_B_REVISION_REQUESTED'],
  AWAITING_GO: ['WRITING', 'GO_DENIED'],
  WRITING: ['DONE', 'WRITE_FAILED'],
  // Downstream entry point: once the issues exist, an authorised `forge implement` triggers Gate C
  // (a standalone bare issue is set straight to GATE_C_REQUESTED).
  DONE: ['GATE_C_REQUESTED'],
  // -- Downstream Gate C: implementation + local CI --
  GATE_C_REQUESTED: ['GATE_C_RUNNING', 'GATE_C_FAILED'],
  GATE_C_RUNNING: ['GATE_C_LOOP', 'GATE_C_FAILED'],
  // Implement/CI loop: green -> await the PR; escalated -> await the maintainer; cap reached -> park
  // for arbitration; per-tick cap -> self-transition to continue; failure -> park.
  GATE_C_LOOP: ['GATE_C_LOOP', 'AWAITING_GATE_D', 'AWAITING_GATE_C_INPUT', 'GATE_C_STALLED', 'GATE_C_FAILED'],
  AWAITING_GATE_C_INPUT: ['GATE_C_REVISION_REQUESTED'],
  GATE_C_REVISION_REQUESTED: ['GATE_C_LOOP', 'GATE_C_FAILED'],
  // Maintainer arbitration: input plus one more revision, and nothing else — **it may never jump to
  // AWAITING_GATE_D**. A Gate C stall means a deterministic CI/acceptance check is not green, and this
  // is where red line #3 ("a deterministic gate is never manually skippable") lands: a red CI does not
  // get to open a PR. (Contrast a Gate D stall, which is a subjective disagreement with CI already
  // green, and may therefore be forced forward.)
  GATE_C_STALLED: ['GATE_C_REVISION_REQUESTED'],
  // -- Downstream Gate D: adversarial PR review + test hardening + merge readiness --
  AWAITING_GATE_D: ['GATE_D_REQUESTED'],
  GATE_D_REQUESTED: ['GATE_D_LOOP', 'GATE_D_FAILED'],
  // Adversarial loop: LGTM -> add inner-loop tests; escalated -> await the maintainer; cap reached ->
  // park for arbitration; per-tick cap -> self-transition to continue; failure -> park.
  GATE_D_LOOP: ['GATE_D_LOOP', 'GATE_D_HARDENING', 'AWAITING_GATE_D_INPUT', 'GATE_D_STALLED', 'GATE_D_FAILED'],
  AWAITING_GATE_D_INPUT: ['GATE_D_REVISION_REQUESTED'],
  GATE_D_REVISION_REQUESTED: ['GATE_D_LOOP', 'GATE_D_FAILED'],
  // Single repo, or the last leg hardened -> ready to merge; multiple repos with legs still unreviewed
  // -> switch to the next leg and go back to GATE_D_LOOP (one tree and one PR per repo; only once
  // every leg is hardened does it reach AWAITING_HUMAN_MERGE — see worker.runGateDHardenStep and
  // legs.planGateDAdvance).
  GATE_D_HARDENING: ['AWAITING_HUMAN_MERGE', 'GATE_D_LOOP', 'GATE_D_FAILED'],
  // Maintainer arbitration: force forward to merge-ready, or one more revision.
  GATE_D_STALLED: ['AWAITING_HUMAN_MERGE', 'GATE_D_REVISION_REQUESTED'],
  // Confirmed after a human merge; or more changes requested -> back to the resume point.
  AWAITING_HUMAN_MERGE: ['SHIPPED', 'GATE_D_REVISION_REQUESTED'],
  SHIPPED: [],
  // retry / orphan recovery: a first-round failure goes back to INTAKE; a re-review failure back to
  // the re-review point; an adversarial failure resumes in place (without losing the PM rounds
  // already accumulated).
  GATE_A_FAILED: ['GATE_A_RUNNING', 'INTAKE', 'GATE_A_REVISION_REQUESTED', 'GATE_A_ADVERSARIAL'],
  // retry / orphan recovery: no draft yet -> a clean rerun; a draft exists -> resume in place
  // (ADVERSARIAL_LOOP / the resume point, without losing rounds).
  GATE_B_FAILED: ['GATE_B_RUNNING', 'GATE_B_REQUESTED', 'ADVERSARIAL_LOOP', 'GATE_B_REVISION_REQUESTED'],
  // retry / orphan recovery: resume in place (worktree creation / implementation / the resume point).
  GATE_C_FAILED: ['GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'GATE_C_REVISION_REQUESTED'],
  GATE_D_FAILED: ['GATE_D_REQUESTED', 'GATE_D_LOOP', 'GATE_D_REVISION_REQUESTED', 'GATE_D_HARDENING'],
  GO_DENIED: ['AWAITING_GO'],
  WRITE_FAILED: ['WRITING'],
};

export function canTransition(from: State, to: State): boolean {
  if (from === to) return true;
  return ALLOWED[from]?.includes(to) ?? false;
}
