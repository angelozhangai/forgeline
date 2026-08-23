// Progressive autonomy policy (pure functions, no side effects, exported for unit tests): maps a
// session parked at a **pure authorisation** pause point to the action that should fire automatically,
// according to the autonomy level.
//
// A "pure authorisation pause point" is a gate a human clears with a single click, **supplying no
// information and making no judgement** — they are only authorising the next step. Only these four
// can be automated:
//   CONFIRMED       -> requestGateB    (produce the tech design; internal, reversible, no outbound write)  L>=1
//   AWAITING_GO     -> go              (file it: create issues + publish the design; outbound write + a spend commitment)  L>=2
//   DONE            -> requestGateC    (start implementing; local worktree + CI)                            L>=3
//   AWAITING_GATE_D -> requestReviewPr (open the PR; outbound but reviewable)                               L>=4
//
// **Never automated** (absent from the table = autoActionFor always returns null; this is where the
// red lines land in the policy layer):
//   · AWAITING_HUMAN_MERGE — red line #1, "never merge automatically": even at maximum autonomy, only
//     a human runs ackMerged.
//   · Every *_STALLED / *_INPUT — a subjective disagreement, or something needing a human answer.
//     Autonomy only authorises progress; it does not make judgements on someone's behalf.
//   · GATE_C_STALLED — red line #2, "a deterministic gate is never skippable": with CI red, even a
//     human can only revise.
//   · Every *_FAILED / GO_DENIED / WRITE_FAILED — failure states need human intervention.
//
// The ladder follows pipeline order and is monotonic (minLevel increases along the pipeline): level k
// automates the first k authorisation points. auto-go is invoked by the worker **without --force** —
// if the acceptance lint or the assignment does not pass, the action itself returns !ok and the
// session honestly stays parked waiting for a human (the deterministic and policy gates remain the
// last line of defence, and autonomy cannot route around them).
import type { State } from './states.ts';

export type AutoAction = 'requestGateB' | 'go' | 'requestGateC' | 'requestReviewPr';

const LADDER: Partial<Record<State, { action: AutoAction; minLevel: number }>> = {
  CONFIRMED: { action: 'requestGateB', minLevel: 1 },
  AWAITING_GO: { action: 'go', minLevel: 2 },
  DONE: { action: 'requestGateC', minLevel: 3 },
  AWAITING_GATE_D: { action: 'requestReviewPr', minLevel: 4 },
};

// The top of the autonomy ladder (everything except merge is automated). Config, validation and docs
// share this one source of truth.
export const AUTONOMY_MAX_LEVEL = 4;

// The set of parked states autonomy can trigger automatically (the worker queries only these rather
// than scanning the whole table).
export const AUTONOMY_GATES: readonly State[] = Object.keys(LADDER) as State[];

// Given a state and an autonomy level -> the action to fire automatically; null = do not automate
// (not an authorisation pause point, or the level is too low). Pure function.
export function autoActionFor(state: State, level: number): AutoAction | null {
  const step = LADDER[state];
  if (!step) return null;
  return level >= step.minLevel ? step.action : null;
}
