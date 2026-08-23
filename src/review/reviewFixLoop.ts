// A reusable "review / revise" loop engine: the reviewer (codex, continuing its session) reviews, the fixer
// (claude, continuing its session) revises, and it reviews again — until the result is clean, a revision
// escalates to a human, the hard cap is reached, or the per-tick cap is reached. It is artefact-agnostic
// (generic A), with storage, prompts and parsing all delegated through config hooks.
// It currently serves Gate B (codex reviews / claude revises the tech design); Gate A can reuse it later.
//
// Design notes:
//  · One call runs **several rounds back to back** until one of those four pause points — the 180s cadence is
//    only scheduling; the tick lock plus the 1200s timeout are the protection, matching the multi-round
//    behaviour of the older harden step.
//  · Every round persists the round number, both session ids and the artefact (an orphan recovery loses at
//    most one round and never the draft).
//  · A parse failure first resumes the same session and feeds it back for a re-emit (self-healing,
//    maxParseRepairRetries times), and only parks once exhausted — the design is never silently dropped.

import { parseStructured } from '../llm/structured.ts';

export interface HumanAsk {
  id: string;
  question: string;
  // Decision options (the engine only passes them through and never reads inside). The structure matches
  // DecisionOption in gates/envelopes.ts: a label, whether it is recommended, and the impact.
  options?: { label: string; recommended?: boolean; impact?: string }[];
  context?: string;
  severity?: string;
}

export interface ReviewVerdict {
  verdict: 'LGTM' | 'CHANGES_REQUESTED'; // LGTM = approved, wrap up; CHANGES_REQUESTED = changes needed (findings must be non-empty)
  findings: unknown[];
}

export interface FixOutput<A> {
  artifact: A;
  needsHuman: HumanAsk[];
}

// The conclusion of running to the next pause point. The worker transitions on it (analogous to
// GateAOutcome).
export interface ReviewFixOutcome {
  round: number;
  verdict: 'LGTM' | 'CHANGES_REQUESTED' | 'unknown';
  resolved: boolean; // the reviewer was clean, or there is no reviewer available -> complete (-> AWAITING_GO)
  needsHuman: HumanAsk[] | null; // non-empty -> pause awaiting the maintainer (-> AWAITING_GATE_B_INPUT)
  stalled: boolean; // still unresolved at the hard cap (-> GATE_B_STALLED)
  paused: boolean; // the per-tick cap was reached, or a revision call failed -> self-transition and continue next tick (staying in ADVERSARIAL_LOOP)
  unresolvedFindings: unknown[];
}

// Storage, prompt and parsing delegation. The engine runs only the control flow and touches neither the DB
// nor files.
export interface ReviewFixConfig<A> {
  label: string;
  maxRounds: number; // the hard cap (reaching it -> stalled)
  maxRoundsPerTick: number; // how many fix rounds one step() may run at most (so it cannot hog the tick lock and starve others)
  // Round and sessions (delegated persistence). **Every hook that reads or writes live session state is
  // async** (get/patch return Promises now that SessionStore is async).
  getRound(): Promise<number>;
  setRound(n: number): Promise<void>;
  getReviewerSession(): Promise<string | null>;
  setReviewerSession(id: string | null): Promise<void>;
  getFixerSession(): Promise<string | null>;
  setFixerSession(id: string | null): Promise<void>;
  // The circuit breaker for consecutive fix-call failures (orthogonal to `round`): it increments while fix()
  // keeps returning ok:false (a claude timeout, a crash, an ongoing fault — a poison pill), and trips at
  // maxFixFailures -> stalled, handed to a human (the equivalent of an SQS DLQ plus an alert, or a circuit
  // breaker in the OPEN state); any successful fix resets it to zero (the circuit closes again).
  // `round` counts only "progress that was successfully persisted", so under continuous failure the round
  // never advances and maxRounds never fires — this independent attempt budget is what has to catch it, or a
  // poison pill spins forever burning money and never escalates to a human (the established consensus that a
  // recovery loop must be bounded and must escalate once exhausted: circuit breakers, Temporal's
  // maxAttempts).
  maxFixFailures: number; // the hard cap on consecutive fix failures (reaching it -> stalled). Defaults to 5 (matching typical SQS maxReceiveCount / circuit breaker thresholds)
  getFixFailStreak(): Promise<number>;
  setFixFailStreak(n: number): Promise<void>;
  // The artefact (reads and writes live session state -> async)
  loadArtifact(): Promise<A>;
  persistArtifact(art: A): Promise<void>;
  // The human-answer pipeline: peek reads without clearing (non-empty only on the first round after a
  // resume); it is cleared only once the fixer has successfully persisted — a failure does not clear, so the
  // next tick retries and the maintainer's decision is never lost. (Reads/writes live session state -> async.)
  peekHumanAnswer(): Promise<string | null>;
  clearHumanAnswer(): Promise<void>;
  // Parse-failure self-healing: build the "re-emit" repair instruction from the error (the config implements
  // it with loadPrompt + render; the engine touches no files).
  buildParseRepairPrompt(kind: 'verdict' | 'fix', error: string): string;
  maxParseRepairRetries: number; // how many times a parse failure may resume and feed back for a re-emit (0 = no self-healing)
  parseRepairSleep?: (ms: number) => Promise<void>; // the sleep used to back off a failed feedback call (a real backoff by default; tests inject one that does not sleep)
  // The reviewer's (codex) prompts and parsing
  buildInitialReviewPrompt(art: A): string;
  buildResumeReviewPrompt(art: A): string;
  parseVerdict(text: string): ReviewVerdict;
  // The fixer's (claude) prompts and parsing. **A parse failure returns null** — the engine throws to park on
  // that, and never falls back to the old draft and lets it through silently (which would consume the
  // maintainer's answer without it ever landing in the design).
  buildInitialFixPrompt(findings: unknown[], humanAnswer: string | null): string;
  buildResumeFixPrompt(findings: unknown[], humanAnswer: string | null): string;
  parseFixResult(text: string): FixOutput<A> | null;
  // Persist the residual findings when the hard cap is reached (handed over for human arbitration) (writes
  // live session state -> async)
  persistResidual(round: number, used: string, findings: unknown[]): Promise<void>;
  // Progress and audit events (writes to event_log -> async)
  note(kind: string, detail: unknown): Promise<void>;
}

export interface ReviewCall {
  ok: boolean;
  text: string;
  sessionId: string | null;
  available: boolean; // false -> no reviewer available (on_missing=skip); the error mode is thrown by the driver
  used: string; // 'codex' | 'claude'
  error?: string;
}
export interface FixCall {
  ok: boolean;
  text: string;
  sessionId: string | null;
  costUsd: number | null;
  error?: string;
}
// The injected real calls (wrapping runCodex/runClaude plus the on_missing degradation), so unit tests can
// swap in fake drivers.
export interface ReviewFixDrivers {
  review(prompt: string, opts: { sessionId: string | null; firstCall: boolean }): Promise<ReviewCall>;
  fix(prompt: string, opts: { sessionId: string | null }): Promise<FixCall>;
}

async function resolvedOutcome<A>(cfg: ReviewFixConfig<A>, verdict: 'LGTM' | 'unknown'): Promise<ReviewFixOutcome> {
  return { round: await cfg.getRound(), verdict, resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
}

export async function runReviewFixLoop<A>(cfg: ReviewFixConfig<A>, drv: ReviewFixDrivers): Promise<ReviewFixOutcome> {
  let art: A = await cfg.loadArtifact(); // A is explicit to avoid inferring Awaited<A> (fr.artifact is A, and A itself may be a Promise)
  let humanAnswer = await cfg.peekHumanAnswer(); // non-empty only on the first round after a resume
  let roundsThisTick = 0;

  // Revision parsing (bad JSON -> self-heal by resuming the same fixer session and feeding it back for a
  // re-emit). parseFixResult returning null means unacceptable -> throw.
  const parseFixOrThrow = (text: string): FixOutput<A> => {
    const r = cfg.parseFixResult(text);
    if (!r) throw new Error('The revision output could not be parsed as the agreed JSON');
    return r;
  };
  const reEmitFix = async (instruction: string): Promise<string | null> => {
    const f = await drv.fix(instruction, { sessionId: await cfg.getFixerSession() });
    return f.ok ? f.text : null;
  };
  const parseFixWithRepair = (text: string): Promise<FixOutput<A>> =>
    parseStructured<FixOutput<A>>({
      text,
      parse: parseFixOrThrow,
      reEmit: reEmitFix,
      buildRepairInstruction: (err) => cfg.buildParseRepairPrompt('fix', err),
      maxRetries: cfg.maxParseRepairRetries,
      sleep: cfg.parseRepairSleep,
      note: cfg.note,
    });

  // Resuming with the maintainer's answer: **unconditionally run one fixer round first** to land that
  // decision in the artefact, and only then enter the normal review -> fix loop.
  // Otherwise the reviewer judging the old draft clean (or on_missing=skip) would resolve immediately, and
  // the maintainer's answer would have been consumed without ever landing in the design.
  // clearHumanAnswer happens only once it has persisted — a failure does not clear it, the next tick retries,
  // and the answer is never lost.
  if (humanAnswer) {
    const fixerSid = await cfg.getFixerSession();
    const firstFix = !fixerSid;
    const fixPrompt = firstFix ? cfg.buildInitialFixPrompt([], humanAnswer) : cfg.buildResumeFixPrompt([], humanAnswer);
    const f = await drv.fix(fixPrompt, { sessionId: fixerSid });
    if (f.ok && f.sessionId && firstFix) await cfg.setFixerSession(f.sessionId);
    if (!f.ok) {
      const streak = (await cfg.getFixFailStreak()) + 1;
      await cfg.setFixFailStreak(streak);
      if (streak >= cfg.maxFixFailures) {
        // Consecutive fix failures hit the cap -> the circuit breaker trips: stalled, handed to a human
        // (never spin forever). The answer is not cleared, so a manual retry tries again.
        await cfg.note('stalled_fix_failures', { stage: 'apply_human_answer', streak, error: f.error ?? null });
        return { round: await cfg.getRound(), verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: true, paused: false, unresolvedFindings: [] };
      }
      await cfg.note('fix_failed', { stage: 'apply_human_answer', streak, error: f.error ?? null });
      return { round: await cfg.getRound(), verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [] };
    }
    await cfg.setFixFailStreak(0); // a successful fix resets the circuit breaker
    // Note: setFixerSession has already run above (when f.ok), so reEmitFix can resume the same session.
    let fr: FixOutput<A>;
    try {
      fr = await parseFixWithRepair(f.text);
    } catch {
      // Still bad once the self-healing is exhausted -> **never fall back to the old draft while consuming
      // the answer**. Throw to park (the raw output is already persisted); because clearHumanAnswer has not
      // been called, the answer is still there and a retry will land the maintainer's decision again.
      await cfg.note('fix_unparsable', { stage: 'apply_human_answer' });
      throw new Error(`${cfg.label}: the revision output failed to parse (while applying the maintainer's answer)`);
    }
    art = fr.artifact;
    await cfg.persistArtifact(art); // the maintainer's decision has landed in the artefact
    await cfg.clearHumanAnswer(); // consumed only after it persisted
    await cfg.note('human_answer_applied', { round: await cfg.getRound() });
    humanAnswer = null;
    if (fr.needsHuman.length > 0) {
      // The answer raised further escalations -> park for a human again.
      const round = await cfg.getRound();
      await cfg.note('needs_human', { round, count: fr.needsHuman.length });
      return { round, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: fr.needsHuman, stalled: false, paused: false, unresolvedFindings: [] };
    }
    roundsThisTick++;
  }

  for (;;) {
    // -- Review (codex; the first round starts a session, later rounds resume it) --
    const reviewerSid = await cfg.getReviewerSession();
    const firstReview = !reviewerSid;
    const reviewPrompt = firstReview ? cfg.buildInitialReviewPrompt(art) : cfg.buildResumeReviewPrompt(art);
    const rev = await drv.review(reviewPrompt, { sessionId: reviewerSid, firstCall: firstReview });
    if (!rev.available) {
      // on_missing=skip: no reviewer available is an **explicitly configured skip** (not a failure) -> treat
      // it as passed and keep the finished draft (-> AWAITING_GO).
      await cfg.note('review_skipped', { reason: 'reviewer_unavailable' });
      return resolvedOutcome(cfg, 'unknown');
    }
    if (!rev.ok) {
      // The reviewer exists but the call failed (a timeout, a non-zero exit, or the degraded self-review also
      // failing) -> **never let it through silently**.
      // Throw -> the worker parks in this gate's *_FAILED state (the driver has already persisted the raw output), and a
      // human retries to continue (upholding "a failure is never silent").
      await cfg.note('review_failed', { used: rev.used, error: rev.error ?? null });
      throw new Error(`${cfg.label}: the review call failed (${rev.used}): ${rev.error ?? 'unknown'}`);
    }
    if (rev.sessionId && firstReview) await cfg.setReviewerSession(rev.sessionId);
    // A parse failure resumes the same reviewer session and feeds it back for a re-emit (self-healing); the
    // degraded claude self-review has no session, so the original prompt is carried back to provide context.
    const reEmitReview = async (instruction: string): Promise<string | null> => {
      const sid = await cfg.getReviewerSession();
      const p = sid ? instruction : `${reviewPrompt}\n\n---\n\n${instruction}`;
      const again = await drv.review(p, { sessionId: sid, firstCall: false });
      return again.available && again.ok ? again.text : null;
    };
    let verdict: ReviewVerdict;
    try {
      verdict = await parseStructured<ReviewVerdict>({
        text: rev.text,
        parse: cfg.parseVerdict,
        reEmit: reEmitReview,
        buildRepairInstruction: (err) => cfg.buildParseRepairPrompt('verdict', err),
        maxRetries: cfg.maxParseRepairRetries,
        sleep: cfg.parseRepairSleep,
        note: cfg.note,
      });
    } catch (e) {
      // Still bad once the self-healing is exhausted -> park (**never silently treat it as approved**) ->
      // throw -> this gate's *_FAILED state (the raw output is already persisted, see logs).
      await cfg.note('review_unparsable', { used: rev.used });
      throw new Error(`${cfg.label}: the review output failed to parse (${rev.used}): ${String(e).slice(0, 160)}`);
    }

    // The candidate round number: it only really counts on LGTM, at the cap, or once a revision has
    // successfully persisted (see each setRound) — a transient revision failure does not advance the round,
    // so it cannot be miscounted as "still unresolved after many rounds" and wrongly parked.
    const round = (await cfg.getRound()) + 1;
    await cfg.note('review_round', { round, used: rev.used, verdict: verdict.verdict, findings: verdict.findings.length });

    // The schema already guarantees LGTM <=> zero findings and CHANGES_REQUESTED <=> non-empty, so only the
    // verdict literal is trusted (no more fragile "empty findings means approved").
    if (verdict.verdict === 'LGTM') {
      await cfg.setRound(round);
      return { round, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
    }
    if (round >= cfg.maxRounds) {
      // Findings remain at the hard cap: persist them for human arbitration, never discard them silently.
      await cfg.setRound(round);
      await cfg.persistResidual(round, rev.used, verdict.findings);
      await cfg.note('stalled', { round, findings: verdict.findings.length });
      return { round, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: true, paused: false, unresolvedFindings: verdict.findings };
    }

    // -- Revise (claude; the first round starts a session, later rounds resume it) --
    const fixerSid = await cfg.getFixerSession();
    const firstFix = !fixerSid;
    const fixPrompt = firstFix
      ? cfg.buildInitialFixPrompt(verdict.findings, humanAnswer)
      : cfg.buildResumeFixPrompt(verdict.findings, humanAnswer);
    const f = await drv.fix(fixPrompt, { sessionId: fixerSid });
    if (f.ok && f.sessionId && firstFix) await cfg.setFixerSession(f.sessionId);
    if (!f.ok) {
      // The revision call failed -> pause and retry, **without advancing the round** (so a transient claude
      // fault is not miscounted as "still unresolved after many rounds" and wrongly parked).
      // But consecutive failures must be bounded: increment the circuit breaker, and at maxFixFailures trip it
      // -> stalled, handed to a human (a poison pill must never spin forever burning money).
      const streak = (await cfg.getFixFailStreak()) + 1;
      await cfg.setFixFailStreak(streak);
      if (streak >= cfg.maxFixFailures) {
        await cfg.persistResidual(round, rev.used, verdict.findings); // persist the residual for human arbitration (as when the hard cap parks)
        await cfg.note('stalled_fix_failures', { round, streak, error: f.error ?? null });
        return { round, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: true, paused: false, unresolvedFindings: verdict.findings };
      }
      await cfg.note('fix_failed', { round, streak, error: f.error ?? null });
      return { round, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: verdict.findings };
    }
    let fr: FixOutput<A>;
    try {
      fr = await parseFixWithRepair(f.text);
    } catch {
      // Still bad once the self-healing is exhausted -> throw to park (the same discipline as a review parse
      // failure; never silently keep the old draft and let it through).
      await cfg.note('fix_unparsable', { round });
      throw new Error(`${cfg.label}: the revision output failed to parse`);
    }
    art = fr.artifact;
    await cfg.persistArtifact(art); // persisted every round, never lost
    await cfg.setRound(round); // the round only really counts once the revision has persisted
    await cfg.setFixFailStreak(0); // a persisted fix resets the circuit breaker (the consecutive-failure count clears)
    humanAnswer = null; // only the first fix carries it in (already consumed by the fix-first step, so this is always null here — kept as a defensive guard)

    if (fr.needsHuman.length > 0) {
      await cfg.note('needs_human', { round, count: fr.needsHuman.length });
      return { round, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: fr.needsHuman, stalled: false, paused: false, unresolvedFindings: verdict.findings };
    }

    roundsThisTick++;
    if (roundsThisTick >= cfg.maxRoundsPerTick && round < cfg.maxRounds) {
      await cfg.note('loop_paused', { round, roundsThisTick });
      return { round, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: verdict.findings };
    }
    // Continue: review the revised draft
  }
}
