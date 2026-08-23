// The presentation layer. Internal code goes on using the State / Gate A / Gate B jargon; everything a
// **human** sees (cards, notifications, issues) is translated here into words product, QA and everyone else
// understands, and carries one consistent requirement number. Change the wording in this one place.
import type { State } from '../statemachine/states.ts';
import type { Session } from '../types.ts';

export const REF_PREFIX = 'REQ-'; // the requirement-number prefix (to switch to PRD-/CR-, change it here)

// The human-readable requirement number: assigned on arrival and carried the whole way through (cards,
// issues and conversations all refer to a requirement by it).
export function reqRef(s: Pick<Session, 'ref_num' | 'slug'>): string {
  return s.ref_num != null ? `${REF_PREFIX}${s.ref_num}` : s.slug;
}

// Internal state -> plain language (product and QA both understand it; "Gate A"/"Gate B"/"GATE_*" must
// never appear).
const LABEL: Record<State, string> = {
  INTAKE: '📥 Received · queued',
  GATE_A_RUNNING: '🔍 Reviewing the requirement (against the live code)',
  AWAITING_PM_CONFIRM: '✋ Waiting on product to confirm',
  GATE_A_REVISION_REQUESTED: '🔁 Reviewing again with your answers',
  GATE_A_ADVERSARIAL: '🔬 Double-checking the requirement (a second AI cross-reviews it)',
  GATE_A_STALLED: '⚖️ Waiting on the owner to decide',
  CONFIRMED: '✅ Requirement confirmed',
  GATE_B_REQUESTED: '📐 Waiting for a technical plan',
  GATE_B_RUNNING: '📐 Designing the technical plan',
  ADVERSARIAL_LOOP: '🔬 Cross-reviewing the plan',
  AWAITING_GATE_B_INPUT: '🙋 Waiting on the owner (the plan has an open question)',
  GATE_B_REVISION_REQUESTED: '🔁 Revising the plan with your answers',
  AWAITING_GO: '🚦 Waiting on the go-ahead',
  WRITING: '✍️ Creating the work items',
  DONE: '🎉 Work items created',
  // Downstream: implementation + local CI
  GATE_C_REQUESTED: '🛠️ Waiting to be built',
  GATE_C_RUNNING: '🛠️ Writing the code (in an isolated workspace)',
  GATE_C_LOOP: '🛠️ Writing code and running the local checks',
  AWAITING_GATE_C_INPUT: '🙋 Waiting on the owner (the build has an open question)',
  GATE_C_REVISION_REQUESTED: '🔁 Carrying on with your answers',
  // Downstream: PR review + test hardening + merge
  AWAITING_GATE_D: '🚦 Waiting to open the PR for review',
  GATE_D_REQUESTED: '🔀 PR opened · waiting for review',
  GATE_D_LOOP: '🔬 Cross-reviewing the PR',
  AWAITING_GATE_D_INPUT: '🙋 Waiting on the owner (the changes have an open question)',
  GATE_D_REVISION_REQUESTED: '🔁 Revising with the review comments',
  GATE_D_HARDENING: '🧪 Strengthening the tests',
  AWAITING_HUMAN_MERGE: '✋ Waiting to be merged by a human',
  SHIPPED: '🚀 Merged and shipped',
  GATE_A_FAILED: '⚠️ Review interrupted · awaiting retry',
  GATE_B_FAILED: '⚠️ Planning interrupted · awaiting retry',
  GATE_B_STALLED: '⚖️ Waiting on the owner to decide (several plan reviews, still unsettled)',
  GATE_C_FAILED: '⚠️ Build interrupted · awaiting retry',
  GATE_C_STALLED: '⚖️ Waiting on the owner to decide (several rounds, the local checks still fail)',
  GATE_D_FAILED: '⚠️ Review interrupted · awaiting retry',
  GATE_D_STALLED: '⚖️ Waiting on the owner to decide (several PR reviews, still unsettled)',
  GO_DENIED: '⛔ Rejected',
  WRITE_FAILED: '⚠️ Could not create the work items · awaiting retry',
};

export function stateLabel(state: State): string {
  return LABEL[state] ?? String(state);
}

// The phase names in plain language: what Gate A and Gate B are called on the outside.
export const PHASE_A = 'requirement review';
export const PHASE_B = 'technical plan';

// Card and notification titles: number · title (truncated), optionally with a leading emoji. One glance
// tells you which requirement this is.
export function refTitle(s: Pick<Session, 'ref_num' | 'slug' | 'title'>, prefix = ''): string {
  const t = (s.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return `${prefix}${reqRef(s)}${t ? ` · ${t}` : ''}`;
}
