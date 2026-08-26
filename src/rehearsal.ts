// Rehearsal mode — the **upstream pipeline walked end to end with nothing real behind it**.
//
// `forge rehearse --pipeline "<any sentence>"` registers a session for real, and the state machine then runs
// exactly as it does in production: intake -> Gate A -> the PM loop -> Gate A's adversarial pass -> Gate B ->
// Gate B's adversarial loop (including one escalation to the maintainer) -> GO -> the writes -> DONE. Every
// card that path produces is really sent to the configured IM, and every state transition is really
// persisted.
//
// Two boundaries are replaced, and they are the two that would otherwise make this expensive or destructive:
//
//   1. **The model calls.** `runClaude` / `runClaudeBare` / `runCodex` return the canned envelopes below
//      instead of spawning the CLI. No tokens are spent.
//   2. **The mechanical actions on the target project.** `projectActions()` returns the no-write adapter in
//      `project/rehearsal.ts`, so no issue is created, no document is scaffolded or published, and no label
//      is applied. (Because the scaffold never runs, the delivery document never exists, and Gate A/B's
//      `appendMachineSection` already returns early when it is missing — so the target project's checkout is
//      not touched at all. `git fetch` still runs, which is read-only and is exactly the part worth
//      exercising: it proves the project configuration points at something real.)
//
// **Why the canned replies live in one table rather than at each call site.** Every gate reaches the model
// through `runClaude`/`runCodex`, and the only thing those two see is `opts.label`. Dispatching on the label
// here means the gates stay untouched — there is no `if (rehearsal)` anywhere in gate code, and so no chance
// of a gate quietly diverging from the path it takes in production.
//
// **An unknown label is a hard error, never a fallthrough.** Falling back to the real CLI would spend money
// during what the operator was told is a free rehearsal — the single worst outcome this file can produce. So
// `cannedText` throws, the gate parks in its `*_FAILED` state, and the reason names the label. The set of
// labels is pinned from the other side by test/rehearsal.test.ts, which greps the gates for every label they
// pass and fails when one is neither answered here nor listed as deliberately out of scope.
import { log } from './util/log.ts';

export const REHEARSAL_ENV = 'FORGE_REHEARSAL';

// Read from the environment rather than config on purpose: config is the place for decisions a deployment
// makes and keeps, and "everything downstream of here is fake" must never be one of those. An environment
// variable lives exactly as long as the command that set it.
export function rehearsalOn(): boolean {
  return process.env[REHEARSAL_ENV] === '1';
}

// The slug prefix a rehearsal session is filed under. Anything in the state directory (or in a chat) carrying
// this prefix came from a rehearsal and is safe to delete.
export const REHEARSAL_SLUG_PREFIX = 'rehearsal-pipeline';

export type Stage =
  | 'gate-a' // the first Gate A pass (and its parse-repair re-emit): open questions for the PM
  | 'gate-a-rereview' // a Gate A round after the PM answered: nothing left open
  | 'gate-a-verdict' // codex picking holes in Gate A's verdict
  | 'gate-a-fix' // claude revising Gate A per those findings
  | 'gate-b' // the tech-design draft (and its parse-repair re-emit)
  | 'gate-b-verdict' // codex reviewing the design
  | 'gate-b-fix' // claude revising the design (round 1 escalates to the maintainer)
  | 'slug'; // runClaudeBare asking for an English slug

// Exact label -> stage. The one dynamic label (`Gate A · re-review #N`) is matched by prefix below.
export const BY_LABEL: Record<string, Stage> = {
  'Gate A': 'gate-a',
  'Gate A · repair output': 'gate-a',
  'Gate A · adversarial': 'gate-a-verdict',
  'Gate A · adversarial · claude': 'gate-a-verdict',
  'Gate A · revise the review': 'gate-a-fix',
  'Gate B': 'gate-b',
  'Gate B · repair the output': 'gate-b',
  'Gate B · adversarial': 'gate-b-verdict',
  'Gate B · adversarial · claude': 'gate-b-verdict',
  'Gate B · revise the design': 'gate-b-fix',
};
export const BY_PREFIX: [string, Stage][] = [['Gate A · re-review', 'gate-a-rereview']];

// Labels the rehearsal deliberately does **not** answer, with the reason. Reaching one is a hard error, not a
// fallthrough — but a named one, so the operator is told "you drove this past where the rehearsal goes"
// rather than "unknown label".
export const OUT_OF_SCOPE: Record<string, string> = {
  'Gate C · implement': 'Gate C writes code into a real worktree; the rehearsal stops at DONE',
  'Gate D · PR review': 'Gate D reviews a real PR diff; the rehearsal stops at DONE',
  'Gate D · PR review · claude': 'Gate D reviews a real PR diff; the rehearsal stops at DONE',
  'Gate D · revise': 'Gate D writes code into a real worktree; the rehearsal stops at DONE',
  'Gate D · harden': 'Gate D writes code into a real worktree; the rehearsal stops at DONE',
  'drift reconciliation': 'the drift loop audits requirements that really shipped; a rehearsal never ships',
  // Neither of these is reachable from the state machine, so a rehearsal cannot wander into them by
  // accident — they are named anyway so that running one *with the variable still set* says why it
  // refused instead of "unknown label".
  probe: 'the contract probe exists to call the real CLI and check its envelope; a canned reply would always pass',
  'eval-judge:acceptance': 'the golden eval measures real model output; judging a canned envelope measures nothing',
};

export function stageForLabel(label: string | undefined): Stage | null {
  if (label == null) return 'slug'; // runClaudeBare passes no label
  if (BY_LABEL[label]) return BY_LABEL[label];
  for (const [prefix, stage] of BY_PREFIX) if (label.startsWith(prefix)) return stage;
  return null;
}

// How many times each stage has been asked, this process. The rehearsal is one command in one process, and
// the counter only has to distinguish "the first adversarial round" from "the second" — so it is deliberately
// in memory and deliberately not persisted. A restart mid-rehearsal starts the walk again, which is the
// honest behaviour for a throwaway run.
const tally = new Map<Stage, number>();

export function resetRehearsalTally(): void {
  tally.clear();
}

export function rehearsalCallCount(stage: Stage): number {
  return tally.get(stage) ?? 0;
}

// A fenced block is what a model really emits, so the extraction path in util/json.ts is exercised rather
// than bypassed.
function fenced(v: unknown): string {
  return `Rehearsal stub output.\n\n\`\`\`json\n${JSON.stringify(v, null, 2)}\n\`\`\`\n`;
}

const NOTE = 'REHEARSAL — canned output; no model was called and none of this is a real judgement.';

// A Gate A envelope. `open` decides whether the PM still has questions to answer.
function gateAEnvelope(open: boolean): unknown {
  return {
    summary: `${NOTE} A rehearsal of the requirement review, produced from a fixed template.`,
    repos_touched: [],
    size: 'M',
    size_reason: 'Fixed by the rehearsal template; no sizing judgement was made.',
    open_questions: open
      ? [
          {
            q: 'Should the rehearsal report land in this chat, or in a thread under the original message?',
            suggestion: 'Either is fine — this question exists only to render a decision card.',
            severity: 'high',
            options: [
              { label: 'In this chat', recommended: true, impact: 'everyone following the channel sees it' },
              { label: 'In a thread', recommended: false, impact: 'keeps the channel quieter' },
            ],
          },
          {
            q: 'How far back should the rehearsal keep its own records?',
            suggestion: 'Pick one; nothing depends on the answer.',
            severity: 'med',
            options: [
              { label: '7 days', recommended: true, impact: 'enough to compare two runs' },
              { label: '30 days', recommended: false, impact: 'more history, more state to clean up' },
            ],
          },
        ]
      : [],
    risks: [
      {
        area: 'rehearsal',
        detail: 'Nothing in this envelope came from reading any code — do not act on it.',
        evidence: 'src/rehearsal.ts',
      },
    ],
    confidence: 0.5,
    needs_lead: false,
    prd_score: 50,
    prd_score_dims: { clarity: 50, completeness: 50, feasibility: 50, testability: 50 },
    prd_score_reason: NOTE,
  };
}

// A Gate B envelope. `repo: 'C'` is a placeholder: the target project's repo map is not visible from here
// (the stub sees only a label), and an unmapped key falls through to the literal, which the no-write adapter
// simply logs. The acceptance below is deliberately **unscoped** — no `repo` on the contract or the scenario —
// so lintAcceptance's per-repo coverage check passes whatever the project's repo keys turn out to be.
function gateBEnvelope(): unknown {
  return {
    summary: `${NOTE} A rehearsal of the technical plan.`,
    key_decisions: { rehearsal: 'Every value here is fixed; no design work was done.' },
    tech_design_markdown:
      `## Rehearsal technical plan\n\n${NOTE}\n\n` +
      'This document exists only so the publish and issue-creation path has something to carry. It describes no real work.\n',
    acceptance: {
      contracts: [{ repo: '', surface: 'rehearsePipeline(sentence: string): Promise<PipelineReport>' }],
      scenarios: [
        {
          id: 'AC1',
          repo: '',
          gherkin:
            'Given a rehearsal session has reached the GO card\nWhen the go-ahead is given\nThen the session reaches DONE and no issue has been created',
        },
      ],
    },
    multi_repo: false,
    epic_title: '',
    epic_doc_type: 'feat',
    issue_specs: [
      {
        repo: 'C',
        title: 'REHEARSAL — not a real work item',
        type: 'feat',
        prio: 'P2',
        body: NOTE,
      },
    ],
    confidence: 0.5,
  };
}

// The first round asks for a change and the second approves: one full adversarial round trip, which is what a
// rehearsal is for — not a realistic argument.
function verdict(call: number, where: string): unknown {
  return call === 1
    ? {
        verdict: 'CHANGES_REQUESTED',
        findings: [
          {
            severity: 'med',
            issue: 'A rehearsal finding, raised so one revision round really runs.',
            where,
            fix: 'Nothing to fix; the next round approves.',
            evidence: 'src/rehearsal.ts',
          },
        ],
      }
    : { verdict: 'LGTM', findings: [] };
}

// The canned assistant text for one call. Throws when the label is not one the rehearsal answers — see the
// header: falling through to the real CLI would spend money during a free rehearsal.
export function cannedText(label: string | undefined): string {
  const stage = stageForLabel(label);
  if (!stage) {
    const why = label != null ? OUT_OF_SCOPE[label] : undefined;
    throw new Error(
      why
        ? `${REHEARSAL_ENV}=1: "${label}" is out of the rehearsal's scope (${why}). The real CLI is never called while the rehearsal is on.`
        : `${REHEARSAL_ENV}=1: no canned reply for the model call labelled "${label ?? '(none)'}". Teach src/rehearsal.ts about it (test/rehearsal.test.ts pins the set); the real CLI is never called while the rehearsal is on.`,
    );
  }
  const call = (tally.get(stage) ?? 0) + 1;
  tally.set(stage, call);
  log.info(`  ${label ?? '(slug)'} -> rehearsal stub (${stage}, call ${call})`);
  switch (stage) {
    case 'gate-a':
      return fenced(gateAEnvelope(true));
    case 'gate-a-rereview':
      return fenced(gateAEnvelope(false));
    case 'gate-a-verdict':
      return fenced(verdict(call, 'open_questions'));
    case 'gate-a-fix':
      // Gate A never escalates to a human — needs_human is always empty (uncertain points go through the PM
      // loop instead), which is what GATE_A_FIX_CONTRACT states.
      return fenced({ artifact: gateAEnvelope(false), needs_human: [] });
    case 'gate-b':
      return fenced(gateBEnvelope());
    case 'gate-b-verdict':
      return fenced(verdict(call, 'acceptance'));
    case 'gate-b-fix':
      // Round 1 escalates, so the maintainer's decision card (needs_gateb_input) is exercised too; once the
      // answer comes back the loop resumes with a fix that escalates nothing.
      return fenced({
        artifact: gateBEnvelope(),
        needs_human:
          call === 1
            ? [
                {
                  id: 'H1',
                  question: 'The rehearsal needs one decision so the escalation card renders — either answer is fine.',
                  options: [
                    { label: 'Carry on', recommended: true, impact: 'the rehearsal continues to the GO card' },
                    { label: 'Carry on anyway', recommended: false, impact: 'identical; the choice is not read' },
                  ],
                  context: NOTE,
                  severity: 'med',
                },
              ]
            : [],
      });
    case 'slug':
      return REHEARSAL_SLUG_PREFIX;
  }
}
