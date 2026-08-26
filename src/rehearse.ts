// `forge rehearse` — the whole outbound card surface, sent for real, against a real workspace, with
// **nothing else real**: no model call, no session in the database, no issue created, no document
// published. It exists because the one thing local tests can never settle is what the IM provider itself
// does with a payload, and finding that out should not cost a paid gate run.
//
// What it covers that the structural gate (test/slack-blockkit.test.ts) cannot:
//   - the provider **accepts** each card, rather than the card merely being structurally valid;
//   - a form really answers in one click: the context comes back with the button and every field with it;
//   - the ack lands inside the provider's window (a miss shows up as the same callback arriving twice).
//
// Two deliberate non-goals, so nobody reads more into a green rehearsal than it earns:
//   - it does not exercise the gates or the state machine (1198 unit tests do, and stubbing the model here
//     would only re-test them through a fake);
//   - it does not prove intake — no message is parsed, because nothing is registered.
//
// Safety: the only outward effect is messages in the chat you configured. The fake session never reaches
// the store, so no button click can advance anything; a click is caught here, printed, and dropped.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { port } from './messaging/index.ts';
import type { MessagingPort } from './messaging/port.ts';
import { buildCard, buildStatusCard, NOTIFY_KINDS, type NotifyKind } from './notify.ts';
import { STATES, type State } from './statemachine/states.ts';
import { log } from './util/log.ts';
import type { InboundCardAction } from './messaging/model.ts';
import type { Session } from './types.ts';

// Every rehearsal card carries this slug, so a stray click that somehow reached a running daemon would look
// for a session that cannot exist and be refused — rather than landing on one of your real requirements.
export const REHEARSAL_SLUG = 'rehearsal-not-a-real-requirement';

// A Gate A envelope with enough substance for the decision form to have real dropdowns in it. Rendering
// reads it off disk (readGateA), so it is written to a temp file rather than injected — the same path the
// real card takes.
const GATE_A_FIXTURE = {
  summary: 'REHEARSAL — this is not a real requirement review. Nothing here was produced by a model.',
  repos_touched: ['example-web'],
  size: 'M',
  size_reason: 'Fixed text: the rehearsal never sizes anything.',
  open_questions: [
    {
      q: 'REHEARSAL question 1 — does this dropdown carry its answer back?',
      suggestion: 'Pick anything; the answer is printed here and then dropped.',
      severity: 'high',
      options: [
        { label: 'Option A (recommended)', recommended: true, impact: 'Nothing happens either way' },
        { label: 'Option B', recommended: false, impact: 'Nothing happens either way' },
      ],
    },
    {
      q: 'REHEARSAL question 2 — do several questions survive one submission?',
      suggestion: 'Answer this one differently from question 1, so a mix-up is visible.',
      severity: 'med',
      options: [
        { label: 'Yes', recommended: true, impact: 'Nothing happens either way' },
        { label: 'No', recommended: false, impact: 'Nothing happens either way' },
      ],
    },
    {
      q: 'REHEARSAL question 3 — is the free-text note carried back too?',
      suggestion: 'Leave this one on its default and type something in the notes box instead.',
      severity: 'low',
      options: [],
    },
  ],
  risks: [{ area: 'none', detail: 'A rehearsal has no risks; this row exists so the card renders its risk count.', evidence: '' }],
  confidence: 0.5,
  needs_lead: false,
};

function fixturePath(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'forge-rehearse-'));
  const p = resolve(dir, 'gate-a.json');
  writeFileSync(p, JSON.stringify(GATE_A_FIXTURE, null, 2));
  return p;
}

/** A session that exists only in memory, for rendering. It is never persisted, and never can be. */
export function rehearsalSession(gateAPath: string | null, p: Partial<Session> = {}): Session {
  return {
    id: 'rehearsal',
    slug: REHEARSAL_SLUG,
    title: 'REHEARSAL — a fake requirement used to prove the cards work',
    state: 'AWAITING_PM_CONFIRM',
    branch: 'dev',
    project_id: 'demo',
    gate_a_output_path: gateAPath,
    gate_a_round: 1,
    gate_b_round: 1,
    routing: null,
    adversarial_residual: null,
    gate_a_cost_usd: 0,
    gate_b_cost_usd: 0,
    confirmed_by: null,
    confirmed_notes: null,
    size: 'M',
    error: 'REHEARSAL — a fixed string standing in for a failure, so the failure cards render',
    prd_url: null,
    ...p,
  } as unknown as Session;
}

export type RehearsePart = 'dm' | 'channel' | 'all';

export interface RehearseOpts {
  only?: RehearsePart;
  listen?: boolean;
  /**
   * Listen without sending anything. Send a round of cards, come back to them later, and there is nothing
   * connected to receive the click — the provider shows the person a warning triangle on a button that
   * would otherwise have worked. Found exactly that way, in a real workspace.
   */
  listenOnly?: boolean;
  pauseMs?: number;
}

const EXTRA = {
  stage: 'Gate B',
  error: 'REHEARSAL — a fixed string standing in for a failure',
  issues: [{ repo: 'example-web', number: 1, url: 'https://github.com/your-org/example-web/issues/1' }],
  from: 'GATE_B_RUNNING',
  to: 'AWAITING_GO',
};

// The state a kind's card is rendered against. Most kinds read nothing state-specific, but the round
// indicator and the pet only appear in the right state, so the card is rendered where it really lives.
const STATE_FOR_KIND: Partial<Record<NotifyKind, State>> = {
  needs_confirm: 'AWAITING_PM_CONFIRM',
  needs_arbitration: 'GATE_A_STALLED',
  needs_gateb: 'CONFIRMED',
  needs_gateb_input: 'AWAITING_GATE_B_INPUT',
  needs_gateb_arbitration: 'GATE_B_STALLED',
  needs_go: 'AWAITING_GO',
  needs_review_pr: 'AWAITING_GATE_D',
  needs_gatec_input: 'AWAITING_GATE_C_INPUT',
  needs_gatec_arbitration: 'GATE_C_STALLED',
  needs_gated_input: 'AWAITING_GATE_D_INPUT',
  needs_gated_arbitration: 'GATE_D_STALLED',
  needs_merge: 'AWAITING_HUMAN_MERGE',
  failed: 'GATE_B_FAILED',
  done: 'DONE',
  recovered: 'GATE_B_RUNNING',
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RehearseReport {
  sent: number;
  failed: string[];
}

// Only the three methods the sending half uses. Narrow on purpose: a test supplies these three and nothing
// else, and the day the corpus starts needing a fourth the type says so instead of a mock silently
// returning undefined.
export type SendPort = Pick<MessagingPort, 'sendDmCard' | 'sendGroupCard' | 'watchedChats'>;

/**
 * Send the corpus. Paced deliberately: providers rate-limit per channel, and a 429 storm midway through
 * would read as "the card is broken" when it is only "too fast".
 */
export async function sendCorpus(o: RehearseOpts = {}, p: SendPort = port): Promise<RehearseReport> {
  const pause = o.pauseMs ?? 350;
  const only = o.only ?? 'all';
  const gateA = fixturePath();
  const failed: string[] = [];
  let sent = 0;

  if (only === 'all' || only === 'dm') {
    log.info(`REHEARSAL · ${NOTIFY_KINDS.length} direct-message cards (one per kind, including the two that carry a form)`);
    for (const kind of NOTIFY_KINDS) {
      const s = rehearsalSession(gateA, { state: STATE_FOR_KIND[kind] ?? 'AWAITING_GO' });
      const ok = await p.sendDmCard(buildCard(kind, s, EXTRA)).catch(() => false);
      sent++;
      if (ok) log.ok(`  DM  ${kind}`);
      else {
        failed.push(`dm:${kind}`);
        log.err(`  DM  ${kind} — NOT delivered`);
      }
      await sleep(pause);
    }
  }

  if (only === 'all' || only === 'channel') {
    const chat = p.watchedChats()[0];
    if (!chat) {
      log.warn('no watched chat is configured, so the channel status cards are skipped (this is the only part that needs one)');
    } else {
      log.info(`REHEARSAL · ${STATES.length} channel status cards (one per state) to ${chat}`);
      for (const state of STATES) {
        const s = rehearsalSession(gateA, { state });
        const id = await p.sendGroupCard(chat, buildStatusCard(s, EXTRA)).catch(() => null);
        sent++;
        if (id) log.ok(`  CH  ${state}`);
        else {
          failed.push(`channel:${state}`);
          log.err(`  CH  ${state} — NOT delivered`);
        }
        await sleep(pause);
      }
    }
  }
  return { sent, failed };
}

// What one incoming callback means. Pure, and the whole point of the listening half — so it is decided here
// and merely printed below.
//   duplicate: the provider redelivered a callback it had already sent, which is what a missed ack looks
//              like from this side (there is no other way to observe the ack window from outside);
//   foreign:   the slug is not the rehearsal one, so this click came from a real card and must not be read
//              as a rehearsal result.
export interface Observation {
  count: number; // how many times this exact callback has now arrived (1 = first time)
  duplicate: boolean;
  foreign: boolean;
}
export function observeCallback(seen: Map<string, number>, a: Pick<InboundCardAction, 'action' | 'slug' | 'formValues'>): Observation {
  const key = `${a.action}|${a.slug}|${JSON.stringify(a.formValues)}`;
  const count = (seen.get(key) ?? 0) + 1;
  seen.set(key, count);
  return { count, duplicate: count > 1, foreign: a.slug !== REHEARSAL_SLUG };
}

/**
 * Keep the inbound connection open and print every callback verbatim. This is the half that answers the
 * questions a local test cannot: the modal opened, the context came back, and the ack was in time.
 *
 * Duplicate detection is the ack check: providers redeliver an envelope that was not acked in time, so the
 * same callback arriving twice is not a mystery — it is the ack window being missed, reported as such.
 */
// Someone touching an input rather than pressing a button. Provider-neutral by construction: it asks whether
// the callback carries an action that is not a button, which is what a form edit looks like on any of them.
function isFormEdit(raw: Record<string, unknown>): boolean {
  const a = (raw.actions as { type?: string }[] | undefined)?.[0];
  return !!a && a.type !== 'button';
}

export function listenForCallbacks(): { close: () => void } {
  const seen = new Map<string, number>();
  const started = Date.now();
  const channel = port.startInbound({
    onCardAction: (raw) => {
      const a = port.parseCardAction(raw);
      if (!a) {
        // An inline form dispatches on **every** selection, and the adapter deliberately returns null for
        // those — only the submit button is an answer. Reporting each one as "unrecognised" would bury the
        // real thing this line exists to catch: a callback the adapter genuinely cannot read.
        if (isFormEdit(raw)) {
          log.info('  <- (a selection was made; not a submission)');
          return;
        }
        log.warn('  <- a callback arrived that the adapter did not recognise (printed raw below)');
        log.warn(`     ${JSON.stringify(raw).slice(0, 400)}`);
        return;
      }
      const o = observeCallback(seen, a);
      const at = `${((Date.now() - started) / 1000).toFixed(1)}s`;
      log.ok(`  <- ${at}  action=${a.action}  slug=${a.slug}  by=${a.operatorId ?? '?'}`);
      log.info(`     value      ${JSON.stringify(a.value)}`);
      log.info(`     formValues ${JSON.stringify(a.formValues)}`);
      if (o.foreign) log.warn('     ⚠️ that slug is not the rehearsal one — this callback came from a real card');
      if (o.duplicate) {
        log.err(`     ⚠️ DUPLICATE (#${o.count} of this exact callback) — the provider redelivered it, which means the ack missed its window`);
      }
    },
    onMessage: () => {
      /* a rehearsal registers nothing: an inbound message is not its business */
    },
    onError: (reason) => log.warn(`  connection error: ${reason}`),
    onReconnected: () => log.ok('  reconnected (a planned swap or a recovered drop — both are the thing an hour-long rehearsal is watching for)'),
  });
  void channel.connect().catch((e) => log.err(`the inbound connection failed: ${String(e).slice(0, 200)}`));
  return { close: () => channel.close?.() };
}

export async function rehearse(o: RehearseOpts = {}): Promise<void> {
  log.info('── REHEARSAL ──');
  log.info(`provider=${port.id} · no model call, no database write, no issue, no document — the only effect is messages in your chat`);
  if (o.listenOnly) {
    log.info('listen-only: nothing is being sent — reconnecting to the cards already in your chat');
  } else {
    const r = await sendCorpus(o);
    log.info(`sent ${r.sent} card(s); ${r.failed.length ? `NOT delivered: ${r.failed.join(', ')}` : 'every one was accepted'}`);
  }

  if (!o.listen && !o.listenOnly) {
    log.info('press the buttons and run `forge rehearse --listen-only` to see what comes back (or pass --listen next time to do both in one go)');
    return;
  }
  if (!port.inboundConfigured()) {
    log.warn('the inbound transport is not configured, so button callbacks cannot be received — the sending half above still ran');
    return;
  }
  log.info('listening for callbacks — press the buttons on the cards above, then ctrl-c when you are done');
  const h = listenForCallbacks();
  await new Promise<void>((done) => {
    const stop = (): void => {
      h.close();
      done();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
