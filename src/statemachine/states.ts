// Per-requirement lifecycle states. Erasable TS: a const array plus a union type, not an enum.

export const STATES = [
  'INTAKE',
  'GATE_A_RUNNING',
  'AWAITING_PM_CONFIRM',
  'GATE_A_REVISION_REQUESTED', // the PM has answered; awaiting re-review in the same session (Gate A's multi-round loop)
  'GATE_A_ADVERSARIAL', // Gate A codex-reviews / claude-revises: after claude's re-review has no open questions, one adversarial pass is still required before confirming (poller-driven)
  'CONFIRMED',
  'GATE_B_REQUESTED',
  'GATE_B_RUNNING',
  'ADVERSARIAL_LOOP', // Gate B codex-reviews / claude-revises, multi-round (poller-driven; self-transitions to continue when the per-tick cap is reached)
  'AWAITING_GATE_B_INPUT', // claude escalated the design as needs_human -> parked awaiting the maintainer (Gate B human-in-the-loop)
  'GATE_B_REVISION_REQUESTED', // the maintainer has answered; awaiting resume in the same session (symmetric with GATE_A_REVISION_REQUESTED)
  'AWAITING_GO',
  'WRITING',
  'DONE', // upstream terminal state: issues created (downstream can trigger Gate C from here; the drift loop also anchors on this state)
  // -- Downstream: Gate C implementation + local CI --
  'GATE_C_REQUESTED', // triggered by forge implement, or by standalone bare-issue intake
  'GATE_C_RUNNING', // create the worktree, materialise/verify acceptance as red, start the implementation
  'GATE_C_LOOP', // bounded implement/CI-fix loop (poller-driven; self-transitions to continue when the per-tick cap is reached)
  'AWAITING_GATE_C_INPUT', // claude escalated the implementation as needs_human -> awaiting the maintainer
  'GATE_C_REVISION_REQUESTED', // resume after the maintainer has answered
  // -- Downstream: Gate D adversarial PR review + test hardening + merge readiness --
  'AWAITING_GATE_D', // Gate C is green -> awaiting an authorised person to open the PR and trigger Gate D (manual by default; later governed by the autonomy policy)
  'GATE_D_REQUESTED', // adversarial review begins once the PR is open
  'GATE_D_LOOP', // codex reviews the diff / claude fixes (CI runs inside the fix; poller-driven)
  'AWAITING_GATE_D_INPUT', // the revision escalated as needs_human -> awaiting the maintainer
  'GATE_D_REVISION_REQUESTED', // resume after the maintainer has answered
  'GATE_D_HARDENING', // after LGTM, add inner-loop tests (no mirror tests) and run CI again (poller-driven)
  'AWAITING_HUMAN_MERGE', // merge-readiness report produced, awaiting a human merge (**never merges automatically**)
  'SHIPPED', // a human confirmed the merge (forge merged) -> hands over to the drift loop
  // Parked states
  'GATE_A_FAILED',
  'GATE_A_STALLED', // Gate A hit its round cap unresolved -> parked for the maintainer to arbitrate
  'GATE_B_FAILED',
  'GATE_B_STALLED', // Gate B's adversarial loop hit its cap unresolved -> parked for the maintainer (force through / one more revision)
  'GATE_C_FAILED',
  'GATE_C_STALLED', // Gate C's CI/acceptance hit its cap still red -> parked for the maintainer
  'GATE_D_FAILED',
  'GATE_D_STALLED', // Gate D's adversarial loop hit its cap unresolved -> parked for the maintainer
  'GO_DENIED',
  'WRITE_FAILED',
] as const;

export type State = (typeof STATES)[number];

// States that advance automatically under the poller, with no human needed -> the worker performs the
// next action.
// Note: the step for GATE_B_REQUESTED runs Gate B and the adversarial review through in one go, all
// the way to AWAITING_GO.
export const POLLER_DRIVEN: ReadonlySet<State> = new Set<State>([
  'INTAKE', // -> Gate A -> AWAITING_PM_CONFIRM
  'GATE_A_REVISION_REQUESTED', // -> Gate A re-review (resume) -> AWAITING_PM_CONFIRM / GATE_A_ADVERSARIAL / GATE_A_STALLED
  'GATE_A_ADVERSARIAL', // -> run the codex-review/claude-revise engine -> CONFIRMED / GATE_A_STALLED (or self-transition to continue when paused)
  'GATE_B_REQUESTED', // -> Gate B first draft -> ADVERSARIAL_LOOP
  'ADVERSARIAL_LOOP', // -> run the codex-review/claude-revise engine -> AWAITING_GO / AWAITING_GATE_B_INPUT / GATE_B_STALLED (or self-transition to continue when paused)
  'GATE_B_REVISION_REQUESTED', // -> resume after the maintainer answered -> ADVERSARIAL_LOOP
  // Downstream Gate C
  'GATE_C_REQUESTED', // -> create the worktree, start the implementation -> GATE_C_LOOP
  'GATE_C_LOOP', // -> implement/CI loop -> AWAITING_GATE_D / AWAITING_GATE_C_INPUT / GATE_C_STALLED (or self-transition to continue when paused)
  'GATE_C_REVISION_REQUESTED', // -> resume after the maintainer answered -> GATE_C_LOOP
  // Downstream Gate D
  'GATE_D_REQUESTED', // -> open the PR -> GATE_D_LOOP
  'GATE_D_LOOP', // -> codex reviews the diff / claude fixes -> GATE_D_HARDENING / AWAITING_GATE_D_INPUT / GATE_D_STALLED (or self-transition to continue when paused)
  'GATE_D_REVISION_REQUESTED', // -> resume after the maintainer answered -> GATE_D_LOOP
  'GATE_D_HARDENING', // -> add inner-loop tests + CI -> AWAITING_HUMAN_MERGE
]);

// Pause points waiting on a human (the worker does not touch these).
export const HUMAN_GATES: ReadonlySet<State> = new Set<State>([
  'AWAITING_PM_CONFIRM',
  'GATE_A_STALLED', // awaiting the maintainer's arbitration (force an end / supply input and run another round)
  'CONFIRMED', // awaiting an authorised person to trigger Gate B
  'AWAITING_GATE_B_INPUT', // awaiting the maintainer's answer to claude's escalated design questions (needs_human)
  'GATE_B_STALLED', // awaiting the maintainer's arbitration (force the requirement through / one more revision)
  'AWAITING_GO',
  // Downstream
  'AWAITING_GATE_C_INPUT', // awaiting the maintainer's answer to Gate C implementation escalations
  'GATE_C_STALLED', // awaiting the maintainer's arbitration (input and one more revision only — a red CI may never skip ahead to opening a PR; red line #3)
  'AWAITING_GATE_D', // awaiting an authorised person to open the PR and trigger Gate D
  'AWAITING_GATE_D_INPUT', // awaiting the maintainer's answer to Gate D revision escalations
  'GATE_D_STALLED', // awaiting the maintainer's arbitration (force forward / one more revision)
  'AWAITING_HUMAN_MERGE', // awaiting a human PR merge (never automatic)
]);

// The "a gate is running" active states: a claude/codex subprocess is in flight. The watchdog uses
// this to hold off a forced kill while a gate is running, and the heartbeat/status page uses it to
// show the number of active gates.
// Note: subprocesses are spawned asynchronously and do not block the event loop (see run in
// util/proc.ts).
export const ACTIVE_GATE_STATES: ReadonlySet<State> = new Set<State>([
  'GATE_A_RUNNING',
  'GATE_A_ADVERSARIAL',
  'GATE_B_RUNNING',
  'ADVERSARIAL_LOOP',
  // Downstream: a subprocess (claude/codex/CI) is in flight -> the watchdog grants grace rather than killing
  'GATE_C_RUNNING',
  'GATE_C_LOOP',
  'GATE_D_LOOP',
  'GATE_D_HARDENING',
]);

export const TERMINAL: ReadonlySet<State> = new Set<State>([
  'DONE',
  'SHIPPED',
  'GATE_A_FAILED',
  'GATE_B_FAILED',
  'GATE_C_FAILED',
  'GATE_D_FAILED',
  'GO_DENIED',
  'WRITE_FAILED',
]);
