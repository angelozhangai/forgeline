// `forge rehearse --pipeline "<any sentence>"` — the **upstream pipeline walked end to end for nothing**.
//
// This is the opposite half of src/rehearse.ts. That one sends every card and touches no state; this one
// really registers a session and drives the state machine from INTAKE to DONE, with only the two expensive
// boundaries replaced (see src/rehearsal.ts for which, and why they are replaced there rather than here).
// Every transition is really persisted and every card the path produces is really sent, so what a green run
// proves is the wiring a unit test cannot: that the gates, the store, the notifier and the provider agree
// with each other on a real machine.
//
// **The human decisions are answered by the driver, not by you.** A rehearsal that parks at the PM card and
// waits would need someone sitting in the chat for a walk whose whole point is that it is free and
// unattended. The driver answers each one through the same exported action a button press calls
// (`submitPmAnswers` / `requestGateB` / `submitGateBAnswers` / `go`) — never by writing a state directly, or
// the walk would prove the transitions are reachable while skipping the permission checks and side effects
// that make them real.
//
// **It refuses to run against a state directory that holds anything else.** A rehearsal creates a real
// session, and a real session in someone's production state directory is exactly the kind of debris that
// gets mistaken for a live requirement later. The check is opt-out (`--force`), not opt-in.
import { addPrd } from './intake.ts';
import { tick } from './orchestrator/worker.ts';
import { store as sessions } from './store/index.ts';
import { submitPmAnswers, confirm, requestGateB, submitGateBAnswers, go } from './actions.ts';
import { loadConfig } from './config.ts';

import { REHEARSAL_ENV, REHEARSAL_SLUG_PREFIX, resetRehearsalTally } from './rehearsal.ts';
import { log } from './util/log.ts';
import { fallbackRefFromText, type DocRef } from './docs/index.ts';
import type { Session } from './types.ts';
import type { State } from './statemachine/states.ts';

// Where the walk is expected to stop. DONE is the upstream terminal state; everything else here is a park,
// and reaching one is a **failed** rehearsal — it means the pipeline could not get through on its own.
const SUCCESS: State = 'DONE';
const PARKED: State[] = [
  'GATE_A_FAILED',
  'GATE_A_STALLED',
  'GATE_B_FAILED',
  'GATE_B_STALLED',
  'GO_DENIED',
  'WRITE_FAILED',
];

// States the poller owns: the driver just ticks and lets the gate do its work.
const POLLED: State[] = [
  'INTAKE',
  'GATE_A_RUNNING',
  'GATE_A_REVISION_REQUESTED',
  'GATE_A_ADVERSARIAL',
  'GATE_B_REQUESTED',
  'GATE_B_RUNNING',
  'ADVERSARIAL_LOOP',
  'GATE_B_REVISION_REQUESTED',
  'WRITING',
];

export interface PipelineOpts {
  sentence: string;
  chatId?: string;
  /** Skip the "the state directory is not empty" refusal. */
  force?: boolean;
  /** Safety stop, so a bug in a gate cannot spin here forever. */
  maxRounds?: number;
}

export interface PipelineReport {
  ok: boolean;
  slug: string | null;
  finalState: State | null;
  /** Every distinct state the session passed through, in order — the thing worth reading afterwards. */
  path: State[];
  rounds: number;
  msg: string;
}

// The requirement body, as a ref from whichever source is the registry's fallback.
//
// It goes through `refFromText` rather than `claim`, and the difference is the point: `claim` answers "should
// a paragraph someone posted become a requirement", which is gated because in production that decision costs
// money on every @ of the bot. The operator typing a sentence into a command whose whole output is free is
// not asking that question, so making them switch on a production behaviour first would be the wrong trade.
// Reading the body afterwards takes the ordinary path.
export function rehearsalDocRef(sentence: string): DocRef | null {
  return fallbackRefFromText(sentence);
}

// The slug is forced rather than left to intake. Intake derives one from the title whenever it contains
// usable ASCII, so an English sentence produces an ordinary-looking slug and the rehearsal session becomes
// indistinguishable from a real requirement in the state directory and in every card it sends. Deriving it
// from the content token keeps it deterministic — the same sentence is the same rehearsal.
export function rehearsalSlug(ref: DocRef): string {
  return `${REHEARSAL_SLUG_PREFIX}-${ref.token.slice(0, 8)}`;
}

/** Who the driver acts as. Whoever the deployment lists first is on every allow list by construction. */
export function rehearsalActor(): string {
  const p = loadConfig().permissions;
  return p.go_approvers[0] ?? p.gate_b_allowed[0] ?? 'M';
}

// One step. Split out from the loop so a test can assert the decision for a state without running a gate.
export type Step =
  | { kind: 'tick' }
  | { kind: 'action'; action: 'answer-pm' | 'confirm' | 'request-gate-b' | 'answer-gate-b' | 'go' }
  | { kind: 'stop'; ok: boolean };

export function nextStep(state: State, pmAnswered: boolean): Step {
  if (state === SUCCESS) return { kind: 'stop', ok: true };
  if (PARKED.includes(state)) return { kind: 'stop', ok: false };
  if (POLLED.includes(state)) return { kind: 'tick' };
  switch (state) {
    // The first pass answers, so the PM loop and the re-review round really run; a second visit means the
    // adversarial pass bounced a question back, and answering again would loop forever — so it is closed.
    case 'AWAITING_PM_CONFIRM':
      return { kind: 'action', action: pmAnswered ? 'confirm' : 'answer-pm' };
    case 'CONFIRMED':
      return { kind: 'action', action: 'request-gate-b' };
    case 'AWAITING_GATE_B_INPUT':
      return { kind: 'action', action: 'answer-gate-b' };
    case 'AWAITING_GO':
      return { kind: 'action', action: 'go' };
    default:
      // A downstream state (Gate C/D) or anything new. Stopping is right either way: the rehearsal's scope
      // ends at DONE, and a state this driver has never been taught must not be guessed at.
      return { kind: 'stop', ok: false };
  }
}

const ANSWER = 'REHEARSAL — an automatic answer; nothing here was decided by a person.';

export async function rehearsePipeline(o: PipelineOpts): Promise<PipelineReport> {
  const empty: PipelineReport = { ok: false, slug: null, finalState: null, path: [], rounds: 0, msg: '' };

  if (!o.force) {
    const existing = await sessions.listAll();
    const foreign = existing.filter((s) => !s.slug.startsWith(REHEARSAL_SLUG_PREFIX));
    if (foreign.length) {
      return {
        ...empty,
        msg:
          `refusing to run: the state directory already holds ${foreign.length} session(s) that are not rehearsals ` +
          `(${foreign.slice(0, 3).map((s) => s.slug).join(', ')}${foreign.length > 3 ? ', …' : ''}). ` +
          'Point FORGE_STATE_DIR at a throwaway directory, or pass --force if you really mean this one.',
      };
    }
  }

  // In-process only, and set here rather than expected from the environment so that the one command whose
  // name says "rehearse" cannot be run half-real by forgetting a variable. It is never persisted anywhere.
  process.env[REHEARSAL_ENV] = '1';
  resetRehearsalTally();

  log.info('── REHEARSAL · PIPELINE ──');
  log.info('every state transition and every card is real; the model calls and the writes on the target project are not');

  const ref = rehearsalDocRef(o.sentence);
  if (!ref) {
    return {
      ...empty,
      msg: 'no fallback document source is registered, so a bare sentence cannot become a requirement body here',
    };
  }
  const added = await addPrd({ doc: ref, slug: rehearsalSlug(ref), title: `REHEARSAL — ${o.sentence.slice(0, 60)}`, chatId: o.chatId });
  if (!added.ok || !added.session) return { ...empty, msg: `intake refused it: ${added.msg}` };
  if (added.duplicate) {
    // Deduplication is by content, so the same sentence is the same requirement — which is correct, and is
    // also why saying "already reviewed" here would read as a bug rather than as the feature it is.
    return {
      ...empty,
      slug: added.session.slug,
      finalState: added.session.state,
      msg:
        `this exact sentence has already been rehearsed in this state directory (${added.session.slug}, now ${added.session.state}). ` +
        'Change a word, or point FORGE_STATE_DIR at a throwaway directory.',
    };
  }

  const by = rehearsalActor();
  const id = added.session.id;
  const path: State[] = [added.session.state];
  const max = o.maxRounds ?? 60;
  let pmAnswered = false;
  let rounds = 0;
  let s: Session | null = added.session;

  while (rounds < max) {
    rounds++;
    s = await sessions.get(id);
    if (!s) return { ok: false, slug: added.session.slug, finalState: null, path, rounds, msg: 'the session disappeared from the store mid-walk' };
    if (path[path.length - 1] !== s.state) path.push(s.state);

    const step = nextStep(s.state, pmAnswered);
    if (step.kind === 'stop') {
      const ok = step.ok;
      return {
        ok,
        slug: s.slug,
        finalState: s.state,
        path,
        rounds,
        msg: ok
          ? `reached ${s.state} in ${rounds} round(s) · ${path.join(' -> ')}`
          : `stopped at ${s.state} after ${rounds} round(s) · ${path.join(' -> ')}`,
      };
    }
    if (step.kind === 'tick') {
      await tick();
      continue;
    }
    // A human decision, taken through the same entry point a button press uses.
    const r =
      step.action === 'answer-pm'
        ? await submitPmAnswers(id, by, ANSWER)
        : step.action === 'confirm'
          ? await confirm(id, by, ANSWER)
          : step.action === 'request-gate-b'
            ? await requestGateB(id, by)
            : step.action === 'answer-gate-b'
              ? await submitGateBAnswers(id, by, ANSWER)
              // The DRI is named here rather than assigned in a separate step: opening the work requires
              // one, and `assignee` is the same override the GO card's dropdown submits — so the walk goes
              // through the production path instead of a CLI-only shortcut.
              : await go(id, by, { assignee: by });
    if (step.action === 'answer-pm') pmAnswered = true;
    log.info(`  rehearsal · ${step.action} as ${by} -> ${r.ok ? 'ok' : `refused: ${r.msg}`}`);
    if (!r.ok) {
      return { ok: false, slug: s.slug, finalState: s.state, path, rounds, msg: `${step.action} was refused at ${s.state}: ${r.msg}` };
    }
  }

  return {
    ok: false,
    slug: s?.slug ?? added.session.slug,
    finalState: s?.state ?? null,
    path,
    rounds,
    msg: `gave up after ${max} rounds without reaching ${SUCCESS} · ${path.join(' -> ')}`,
  };
}
