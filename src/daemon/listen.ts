import { loadConfig } from '../config.ts';
import { configForSession } from '../projects.ts';
import { hours } from '../util/time.ts';
import { log } from '../util/log.ts';
import { store as sessions } from '../store/index.ts'; // through the SessionStore seam (the selection point), never straight to store/sessions.ts
import * as cursors from '../store/cursors.ts';
import { tick } from '../orchestrator/worker.ts';
import { confirm, submitPmAnswers, requestGateB, submitGateBAnswers, forceGateBGo, go, deny, retry, composeHumanAnswer, postConfirmComment } from '../actions.ts';
import { readFileSync, existsSync } from 'node:fs';
import { parseHumanAsks, parseOpenQuestions, openQuestionsToDecisions, composeDecisionAnswer } from '../gates/envelopes.ts';
import { addPrd } from '../intake.ts';
import { backfillAll } from '../messaging/backfill.ts'; // the provider-agnostic backfill loop (the one API round trip for history lives in the adapter)
import { maybeBackup } from '../store/backup.ts';
import { notify, syncGroupCard } from '../notify.ts';
import { port } from '../messaging/index.ts';
import { resolveActor } from '../messaging/operators.ts';
import type { CardModel } from '../messaging/index.ts';
import { claimDocs } from '../docs/index.ts';
import { mentionGate } from '../messaging/gate.ts'; // the channel entry gate's criteria, shared with the offline backfill; see that file
import { ACTIVE_GATE_STATES } from '../statemachine/states.ts';
import { healthConfig } from '../health/config.ts';
import { initHeartbeat, pingLiveness, markCycle, markWs } from '../health/heartbeat.ts';
import { startHealthServer } from '../health/server.ts';
import { startControlServer } from '../control/server.ts';
import { evaluateHealth } from '../health/check.ts';
import { recordSample } from '../health/history.ts';
import { sendHealthAlert } from '../health/alert.ts';
import { runContractProbes } from '../health/contract.ts';
import { allProbes, startupProbeDue } from '../store/contract.ts';

async function ack(text: string): Promise<void> {
  await port.sendDmText('⏳ working on it', [text], 'grey').catch(() => undefined);
}

async function handleCardAction(evt: Record<string, unknown>): Promise<void> {
  // Parsing the inbound event is the adapter's job: it normalises the provider's raw event into a
  // provider-agnostic {action, slug, value, formValues}.
  const parsed = port.parseCardAction(evt);
  if (!parsed) {
    log.warn('the cardAction has no action or slug (an unrecognised callback)');
    return;
  }
  const { action: act, slug } = parsed;
  // Who is acting: the IM user id is mapped to a short code, and the permission gate is decided against
  // whoever really clicked (with no operators configured it falls back to the maintainer, which is the old
  // single-person behaviour).
  // operators is taken from **the project this requirement belongs to** (configuration diverges per project:
  // a project can have its own user-id-to-short-code mapping, and the map merge keeps the global entries).
  // If the session cannot be found, or the project overrides nothing, it falls back to global. Otherwise a
  // project-level clicker would be mistaken for the global single-person maintainer (the blocker Codex
  // raised).
  const cardSession = await sessions.resolve(slug);
  const operators = (cardSession ? configForSession(cardSession) : loadConfig()).permissions.operators ?? {};
  const actor = resolveActor(parsed.operatorId, operators);
  log.info(`cardAction: ${act} ${slug} by=${actor}`);
  try {
    if (act === 'confirm_submit') {
      // Product submits their answers in the channel. Note: product *answering* is not product *deciding* —
      // the answers are fed back into the same claude session for another review round (Gate A's loop), and
      // when the review ends is decided by claude (no open question remains) or by the maintainer (forcing it
      // closed). Product cannot end it.
      const fv = parsed.formValues;
      const verdict = fv.verdict || 'accept';
      // Collected item by item: each open_question's dropdown selection (ask_<id>), the overall verdict, and
      // the free-text notes, composed into one structured answer.
      // gate-a.json is read for the same open_questions the card was rendered from, which is what keeps each
      // option lined up with its question.
      const before = await sessions.resolve(slug);
      const oqRaw = before?.gate_a_output_path && existsSync(before.gate_a_output_path) ? readFileSync(before.gate_a_output_path, 'utf8') : '';
      const items = openQuestionsToDecisions(parseOpenQuestions(oqRaw));
      const answerBody = composeDecisionAnswer(items, fv); // the per-item selections plus the notes (with no verdict prefix) — this is what is recorded on the PRD
      const note = composeDecisionAnswer(items, fv, verdict).trim(); // what is fed back for the re-review (including the overall verdict)
      // Guarding the submit button against a second click: syncGroupCard below replaces the channel card's
      // form with a "re-reviewing, round N" card that has no buttons.
      // The backstops: the SDK's own deduplication (12h), submitPmAnswers being idempotent (re-entering
      // REVISION_REQUESTED), and the failure branch refreshing the card too.
      const r = await submitPmAnswers(slug, 'PM', note || undefined);
      const s = await sessions.resolve(slug);
      if (r.ok && s) {
        // The record on the PRD takes the structured answer (including the per-item dropdown selections)
        // rather than the free text alone — otherwise, when product only uses the dropdowns, the record would
        // read "Notes: (none)".
        postConfirmComment(s, { who: 'PM', verdict, notes: answerBody });
        await syncGroupCard(s); // the channel card becomes "re-reviewing, round N" (with the form removed)
        await tick(); // run the re-review immediately; from its result the tick sends needs_confirm (another round), needs_gateb (finished) or needs_arbitration (parked)
      } else {
        if (s) await syncGroupCard(s); // refresh the card on failure too, so a stale form or button does not linger
        await ack(`the submission failed: ${r.msg}`);
      }
      return;
    }
    if (act === 'force_confirm') {
      // The maintainer forces the review closed from the "waiting on a decision" card (product has no such
      // button).
      const r = await confirm(slug, actor);
      const s = await sessions.resolve(slug);
      if (r.ok && s) await notify('needs_gateb', s);
      else await ack(`forcing it through failed: ${r.msg}`);
      return;
    }
    if (act === 'gateb') {
      await ack(`Gate B is queued for ${slug} (producing the plan, then several Codex/Claude adversarial rounds — a few minutes)...`);
      const r = await requestGateB(slug, actor);
      if (!r.ok) await ack(r.msg);
      await tick(); // advance Gate B immediately
      return;
    }
    if (act === 'gateb_answer_submit') {
      // The maintainer submits their decisions from the "the plan is waiting on your decision" card, which is
      // fed back into the same claude session to carry on (Gate B's human-in-the-loop rounds).
      // It reads each dropdown selection (ask_*) plus the notes and composes them by id; when everything is
      // empty, submitGateBAnswers falls back to "one more round".
      const fv = parsed.formValues;
      const before = await sessions.resolve(slug);
      const asks = before ? parseHumanAsks(before.gate_b_human_asks) : [];
      const answer = composeHumanAnswer(asks, fv).trim();
      const r = await submitGateBAnswers(slug, actor, answer || undefined);
      const s = await sessions.resolve(slug);
      if (r.ok && s) {
        await syncGroupCard(s); // the channel card becomes "revising the plan with your answers" (with the form removed)
        await tick(); // carry on immediately; from its result the tick sends the next card (another escalation / waiting on GO / parked for a decision)
      } else {
        if (s) await syncGroupCard(s);
        await ack(`the submission failed: ${r.msg}`);
      }
      return;
    }
    if (act === 'gateb_force_go') {
      // The maintainer forces the work open from the "the plan is waiting on a decision" card -> AWAITING_GO
      // (which computes the automatic assignment along the way).
      const r = await forceGateBGo(slug, actor);
      const s = await sessions.resolve(slug);
      if (r.ok && s) await notify('needs_go', s);
      else await ack(`forcing the work open failed: ${r.msg}`);
      return;
    }
    if (act === 'gateb_send_back') {
      // The maintainer picks "one more round" on the "the plan is waiting on a decision" card.
      const r = await submitGateBAnswers(slug, actor, 'one more round (the maintainer gave no specific notes)');
      const s = await sessions.resolve(slug);
      if (r.ok && s) {
        await syncGroupCard(s);
        await tick();
      } else {
        await ack(`another round could not be started: ${r.msg}`);
      }
      return;
    }
    if (act === 'go') {
      // The GO card's go_form submission: form_value.assignee is the chosen DRI (the recommendation by
      // default, changeable from the dropdown).
      const fv = parsed.formValues;
      const assignee = (fv.assignee ?? '').trim() || undefined;
      await ack(`creating the work items for ${slug}${assignee ? ` (assigned to ${assignee})` : ''}...`);
      const r = await go(slug, actor, assignee ? { assignee } : {}); // success and a write-stage failure each send their own card
      // A pre-check refusal (permissions, the lint, no DRI assigned) sends no card of its own — the session
      // stays in the waiting-on-GO state, so this reply tells the maintainer why nothing was created.
      if (!r.ok) {
        const st = (await sessions.resolve(slug))?.state;
        if (st === 'AWAITING_GO' || st === 'GO_DENIED') await ack(r.msg);
      }
      return;
    }
    if (act === 'deny') {
      const r = await deny(slug, actor); // no permission, or the wrong state -> it is not really sent back, and the reason is replied (never falsely reporting "sent back")
      await ack(r.ok ? `${slug} sent back` : r.msg);
      return;
    }
    if (act === 'retry') {
      const r = await retry(slug, actor); // no permission, or nothing to retry -> it is not really reset, and the reason is replied (never falsely reporting "reset")
      if (!r.ok) {
        await ack(r.msg);
        return;
      }
      await ack(`${slug} reset, re-running...`);
      await tick();
      return;
    }
    log.warn(`unknown cardAction: ${act}`);
  } catch (e) {
    log.err(`handling the cardAction failed: ${String(e).slice(0, 200)}`);
    await ack(`it failed: ${String(e).slice(0, 160)}`);
  }
}

export const __handleCardActionForTest = handleCardAction;

// The duplicate-PRD notice card (grey, posted as a reply to product's message; with no msgId it goes into the
// channel). Best-effort: a failure is only logged and never blocks.
async function replyDuplicate(intakeMsgId: string | undefined, chatId: string, notice: string): Promise<void> {
  const card: CardModel = { color: 'grey', title: '🔁 submitted again', blocks: [{ kind: 'text', md: notice }] };
  try {
    if (intakeMsgId) await port.replyGroupCard(intakeMsgId, card);
    else if (chatId) await port.sendGroupCard(chatId, card);
  } catch (e) {
    log.warn(`replying about the duplicate PRD failed (deduplication is unaffected): ${String(e).slice(0, 120)}`);
  }
}

async function handleMessage(evt: Record<string, unknown>): Promise<void> {
  // Parsing the inbound event is the adapter's job: it normalises the provider's raw event into a
  // provider-agnostic InboundMessage (text plus the searchTexts candidates).
  const m = port.parseMessage(evt);
  if (!m) return;
  const chatId = m.chatId;
  const createTime = m.createTime; // the adapter already falls back to now() (a missing createTime is never 0, which would put the cursor back at the epoch)
  const posterId = m.senderId;
  const intakeMsgId = m.messageId;
  const text = m.text;
  // The channel entry gate: in a channel **only a message that mentions the bot** enters the pipeline —
  // otherwise a document someone casually shares or forwards would be taken for a PRD and run through Gate A,
  // spending money for nothing.
  // The material for that judgement is worked out by the adapter from the **server-populated mentions** in
  // the event (isGroup / mentionedBot, independent of how the SDK normalises an @ in the body); the criteria
  // themselves live in messaging/gate.ts — **shared with** the offline backfill, so the two paths cannot
  // disagree about what counts as a requirement.
  // On the live side "cannot confirm" means ignore: the message is still in the channel, so someone can
  // mention the bot again and the only cost is one repost (the backfill side takes the opposite choice; the
  // reasoning is in gate.ts).
  const gate = mentionGate(m);
  if (gate !== 'admit') {
    if (gate === 'unconfirmable') {
      log.warn(`message entry: a channel message, but whether the bot was mentioned cannot be confirmed (${port.id} has no bot user id configured) -> conservatively ignoring it`);
    } else {
      log.info('message entry: a channel message that does not mention the bot -> ignored by the rule (it does not enter the pipeline)');
    }
    if (chatId) cursors.advanceCursor(chatId, createTime); // the cursor still advances, so a reconnect does not keep re-fetching this non-mentioning message
    return;
  }
  // A link is often not in the plain text (a document share card, or a rich-text post) — the adapter digs
  // those structures out into the searchTexts candidates, and the **document source registry** claims them
  // (whoever recognises it owns it; the fallback source only gets its turn when nobody does). The core knows
  // what none of these links look like.
  const docs = claimDocs({ text, searchTexts: m.searchTexts });
  if (process.env.FORGE_WS_DEBUG === '1') {
    log.info(`message entry received: chat=${chatId} docs=${docs.length} text="${text.slice(0, 80)}" evt=${JSON.stringify(evt).slice(0, 700)}`);
  }
  if (docs.length === 0) {
    log.warn('message entry: no document source claimed this message, so it is ignored');
  } else {
    for (const doc of docs) {
      const r = await addPrd({ doc, chatId: chatId || undefined, posterId, intakeMsgId });
      if (r.ok && r.session) {
        if (r.created) {
          log.ok(`message entry: registered ${r.session.slug}`);
          await syncGroupCard(r.session); // reply beneath product's message in the channel straight away with the status card, for immediate feedback
        } else {
          // PRD-level deduplication: the same requirement submitted again gets a clear reply to product —
          // "this has already been reviewed and will not be reviewed again" — rather than a duplicate.
          log.info(`message entry: a duplicate PRD (${r.session.slug}, ${r.session.state}) -> replying to product`);
          await replyDuplicate(intakeMsgId, chatId, r.msg);
        }
      } else {
        log.warn(`message entry: registration failed ${r.msg}`);
      }
    }
    await tick(); // run Gate A immediately
  }
  // Advance this channel's cursor (including for a message with no link) -> it registers the channel for the
  // backfill and stops a reconnect re-fetching this message.
  if (chatId) cursors.advanceCursor(chatId, createTime);
}

export const __handleMessageForTest = handleMessage;

// The global crash safety net (for the long-running daemon only; a one-shot CLI command does not need it).
// It has two distinct semantics:
// - unhandledRejection: one escaped promise usually does not corrupt global state -> log it, alert the
//   maintainer by direct message, and **carry on** (never swallowed silently, in line with "a failure is
//   never silent").
// - uncaughtException: the process's state can no longer be trusted (Node states plainly that carrying on is
//   unsafe) -> log it, alert, and **exit**, leaving launchd's KeepAlive to restart cleanly; whatever orphaned
//   state the crash left behind is reclaimed by reclaimOrphans plus the poison-pill protection.
// It complements the two existing keep-alive layers (the watchdog rescues a wedge, launchd rescues a death):
// this one is specifically for an async throw that escaped an event handler.
function installCrashHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    const msg = String((reason as { stack?: string } | undefined)?.stack ?? reason).slice(0, 400);
    log.err(`unhandledRejection (caught; the daemon carries on): ${msg}`);
    void port.sendDmText('⚠️ unhandledRejection (the daemon carries on)', [msg], 'red').catch(() => undefined);
  });
  process.on('uncaughtException', (err) => {
    const msg = String(err?.stack ?? err).slice(0, 400);
    log.err(`uncaughtException (the process's state cannot be trusted; exiting gracefully for launchd to restart): ${msg}`);
    // The alert is best-effort: 1.5s is allowed for the card to go out, and it exits either way rather than
    // blocking indefinitely in an untrustworthy state.
    const bail = (): never => process.exit(1);
    const t = setTimeout(bail, 1500);
    void port
      .sendDmText('🔴 uncaughtException (the daemon is restarting)', [msg], 'red')
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(t);
        bail();
      });
  });
}

export async function listen(): Promise<void> {
  installCrashHandlers();
  const cfg = loadConfig();
  const intervalMs = Math.max(30, cfg.runtime.poll_interval_sec || 180) * 1000;

  // Keep-alive and health: start the heartbeat, the local status page, the liveness ping and the health
  // sampling.
  const hcfg = healthConfig();
  initHeartbeat({ pid: process.pid, port: hcfg.port, wsConfigured: port.inboundConfigured(), now: Date.now() });
  startHealthServer(hcfg.port);
  // The control-plane / runner split: when this machine is the **control plane**, the control-plane HTTP
  // surface (/jobs and /store) starts in the same process, so one `forge listen` process is the orchestration
  // (reclaim, retry, autonomy, reminders, the sweep and drift — see worker.tick) plus its own job loop plus
  // serving the extra runners — one sqlite connection, with no contention between processes. This is what
  // "the control-plane process runs the whole tick and serves" actually looks like (an extra runner sets
  // FORGE_CONTROL_URL and runs the job loop only).
  // It starts only when FORGE_CONTROL_PORT is set and this machine is **not a pure runner**
  // (FORGE_CONTROL_URL unset); a pure runner acting as the server is caught by startControlServer's
  // fail-closed guard 2. By default (no PORT) it does not start, and behaviour is unchanged.
  if (process.env.FORGE_CONTROL_PORT && !process.env.FORGE_CONTROL_URL) {
    try {
      await startControlServer({
        port: Number(process.env.FORGE_CONTROL_PORT) || 4320,
        host: process.env.FORGE_CONTROL_HOST || '127.0.0.1',
        token: process.env.FORGE_CONTROL_TOKEN || undefined,
      });
    } catch (e) {
      // Fail fast: a control-plane port configured but impossible to bind means a half-start — health and the
      // tick are alive while /jobs and /store are unavailable and the extra runners can pull no jobs.
      // It exits hard (the health server is already up and holds the event loop, so setting exitCode alone
      // would not exit) and launchd restarts it; if the port stays occupied it fails **loudly and
      // repeatedly**, exposing the misconfiguration, rather than living on silently with no control plane.
      log.err(`the control-plane HTTP surface failed to start; refusing to run without a control plane: ${String(e).slice(0, 200)}`);
      process.exit(1);
    }
  }
  // The liveness ping: a gate is spawned asynchronously and does not block the event loop, so this quick ping
  // is the real liveness signal (and what the watchdog judges a wedge on).
  const pingHealth = async (): Promise<void> => {
    try {
      const active = await sessions.countByStates([...ACTIVE_GATE_STATES]);
      pingLiveness(Date.now(), active);
    } catch {
      /* the ping is best-effort */
    }
  };
  void pingHealth();
  setInterval(() => void pingHealth(), hcfg.livenessPingSec * 1000);
  // Health sampling: it records the rolling history and alerts when the overall status flips (only while the
  // daemon is alive — a process-level outage is the watchdog's job).
  const sampleHealth = async (): Promise<void> => {
    try {
      const report = await evaluateHealth(Date.now());
      const { flipped, prev } = recordSample(report, hcfg.historyRetainHours);
      if (flipped && prev) {
        if (report.status === 'healthy') {
          await sendHealthAlert('recovered', 'the service has recovered', [`back to normal from "${prev}".`]);
        } else {
          const lines = report.checks
            .filter((c) => c.status === 'down' || c.status === 'degraded')
            .map((c) => `- **${c.name}**: ${c.detail}`);
          await sendHealthAlert(report.status === 'down' ? 'down' : 'degraded', report.status === 'down' ? 'the service is disrupted' : 'the service is degraded', lines.length ? lines : ['(no detail)']);
        }
      }
    } catch (e) {
      log.warn(`the health sampling failed: ${String(e).slice(0, 140)}`);
    }
  };
  setInterval(() => void sampleHealth(), hcfg.sampleIntervalSec * 1000);

  // The external dependencies' contracts: an active out-of-band probe once a day (a codex or claude upgrade
  // can quietly change the output schema, and it happens outside anything we commit).
  // The probe costs money (one trivial call each for codex and claude), so it only runs every
  // contract_interval_hours; a drift is debounced on the flip and then sent as a direct message.
  if (hcfg.contractCheckEnabled) {
    const contractDaily = async (): Promise<void> => {
      try {
        await runContractProbes(Date.now());
      } catch (e) {
        log.warn(`the contract probe failed: ${String(e).slice(0, 140)}`);
      }
    };
    // It runs once at startup, so the status page and doctor do not say "not probed yet" — but **throttled by
    // checked_at**: if the most recent probe is within the interval it is skipped, so a daemon
    // crash-restart loop does not pay for a probe on every start (a contract probe is a paid claude and codex
    // call).
    if (startupProbeDue(allProbes(), Date.now(), hours(hcfg.contractIntervalHours))) {
      void contractDaily();
    } else {
      log.info(`the external contracts were last probed within ${hcfg.contractIntervalHours}h, so the startup probe is skipped (which stops a crash-restart loop paying repeatedly; the status page still shows the last result)`);
    }
    setInterval(() => void contractDaily(), hours(hcfg.contractIntervalHours));
    log.ok(`the daily external-contract probe is running (every ${hcfg.contractIntervalHours}h)`);
  }

  // The built-in periodic loop: backfill the channel messages missed while offline, then advance the gates
  // (tick). It keeps running even when the connection never came up.
  const runCycle = async (): Promise<void> => {
    let ok = true;
    try {
      await backfillAll();
    } catch (e) {
      log.err(`the backfill failed: ${String(e).slice(0, 160)}`);
    }
    try {
      await tick();
    } catch (e) {
      ok = false;
      log.err(`the periodic tick failed: ${String(e).slice(0, 160)}`);
    }
    await maybeBackup(Date.now()).catch(() => undefined); // one online backup an hour (throttled internally)
    markCycle(Date.now(), ok);
  };
  void runCycle();
  const timer = setInterval(() => void runCycle(), intervalMs);
  log.ok(`the periodic loop is running (backfill + tick, every ${intervalMs / 1000}s)`);

  if (!port.inboundConfigured()) {
    log.warn(`the inbound transport is not configured (${port.id}'s bot credentials are missing) -> the periodic tick only, with no connection (card buttons and the channel entry point are unavailable)`);
    await new Promise(() => {}); // stays up
    return;
  }

  // The connection is the adapter's job (port.startInbound builds the channel and does the sending and
  // receiving); the core only takes provider-agnostic callbacks, and markWs (the health liveness signal) and
  // runCycle (the backfill) stay in the core — the adapter touches no health or business concept at all.
  const channel = port.startInbound({
    onCardAction: (raw) => {
      markWs(true, Date.now());
      void handleCardAction(raw);
    },
    onMessage: (raw) => {
      markWs(true, Date.now());
      void handleMessage(raw);
    },
    onError: (reason) => {
      markWs(false, Date.now());
      log.err(`the connection errored: ${reason.slice(0, 200)}`);
    },
    // After reconnecting, immediately backfill the channel messages missed while disconnected (the connection
    // does not replay historical events).
    onReconnected: () => {
      markWs(true, Date.now());
      log.ok('the connection is back -> backfilling the channel messages missed while disconnected');
      void runCycle();
    },
  });

  try {
    await channel.connect();
    markWs(true, Date.now());
    log.ok(`the ${port.id} connection is established (card button callbacks and the channel entry point are ready)`);
    void runCycle(); // the first run at startup: pick up the requirements posted while offline
  } catch (e) {
    markWs(false, Date.now());
    log.err(`the connection could not be established: ${String(e).slice(0, 200)} (check whether event subscription over a long connection is enabled in ${port.id}'s app settings — see deploy/README). The periodic tick carries on alone.`);
  }
  // It stays up: connection events plus the periodic tick
  await new Promise(() => {});
  clearInterval(timer); // never reached; kept so the code reads completely
}
