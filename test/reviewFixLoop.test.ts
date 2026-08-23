// The control flow of the review/revise engine (driven by fakes; no real codex or claude runs). It covers:
// a clean first round, escalating to a human, converging over several rounds, parking at the hard cap, pausing
// at the per-tick cap, degrading when the reviewer is unavailable, capturing the session exactly once and
// reusing it, the human answer being carried into the first fix only, and retrying a failed revision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReviewFixLoop } from '../src/review/reviewFixLoop.ts';
import type { ReviewFixConfig, ReviewFixDrivers } from '../src/review/reviewFixLoop.ts';

interface State {
  round: number;
  reviewerSession: string | null;
  fixerSession: string | null;
  artifact: { v: number };
  humanAnswer: string | null;
  residual: { round: number; used: string; findings: unknown[] } | null;
  persists: number;
  events: { k: string; d: unknown }[];
  reviewCalls: { sessionId: string | null; firstCall: boolean }[];
  fixCalls: { sessionId: string | null }[];
  fixHumanAnswers: (string | null)[];
  maxRounds: number;
  maxRoundsPerTick: number;
  maxParseRepairRetries: number;
  fixFailStreak: number;
  maxFixFailures: number;
}

function mkState(o: Partial<State> = {}): State {
  return {
    round: 0, reviewerSession: null, fixerSession: null, artifact: { v: 0 }, humanAnswer: null,
    residual: null, persists: 0, events: [], reviewCalls: [], fixCalls: [], fixHumanAnswers: [],
    maxRounds: 3, maxRoundsPerTick: 99, maxParseRepairRetries: 0, fixFailStreak: 0, maxFixFailures: 5, ...o, // 0 by default: a parse failure throws immediately; the self-healing cases opt in explicitly
  };
}

function mkCfg(state: State): ReviewFixConfig<{ v: number }> {
  return {
    label: 'test',
    maxRounds: state.maxRounds,
    maxRoundsPerTick: state.maxRoundsPerTick,
    maxParseRepairRetries: state.maxParseRepairRetries,
    buildParseRepairPrompt: (kind, error) => `REPAIR:${kind}:${error}`,
    parseRepairSleep: async () => {}, // no real sleeping: the backoff after a failed re-emit call returns instantly in tests
    getRound: () => state.round,
    setRound: (n) => { state.round = n; },
    getReviewerSession: () => state.reviewerSession,
    setReviewerSession: (id) => { state.reviewerSession = id; },
    getFixerSession: () => state.fixerSession,
    setFixerSession: (id) => { state.fixerSession = id; },
    maxFixFailures: state.maxFixFailures,
    getFixFailStreak: () => state.fixFailStreak,
    setFixFailStreak: (n) => { state.fixFailStreak = n; },
    loadArtifact: () => state.artifact,
    persistArtifact: (a) => { state.artifact = a; state.persists++; },
    peekHumanAnswer: () => state.humanAnswer,
    clearHumanAnswer: () => { state.humanAnswer = null; },
    buildInitialReviewPrompt: () => '',
    buildResumeReviewPrompt: () => '',
    parseVerdict: (t) => JSON.parse(t),
    buildInitialFixPrompt: (_f, ha) => { state.fixHumanAnswers.push(ha); return ''; },
    buildResumeFixPrompt: (_f, ha) => { state.fixHumanAnswers.push(ha); return ''; },
    parseFixResult: (t) => { try { const o = JSON.parse(t); return { artifact: o.artifact, needsHuman: o.needs_human ?? [] }; } catch { return null; } },
    persistResidual: (round, used, findings) => { state.residual = { round, used, findings }; },
    note: (k, d) => { state.events.push({ k, d }); },
  };
}

interface RevStep { verdict?: 'LGTM' | 'CHANGES_REQUESTED'; findings?: unknown[]; ok?: boolean; available?: boolean; sessionId?: string | null; used?: string; parseFail?: boolean }
interface FixStep { artifact?: { v: number }; needsHuman?: unknown[]; ok?: boolean; sessionId?: string | null; costUsd?: number; badText?: boolean }

function mkDrivers(state: State, reviewScript: RevStep[], fixScript: FixStep[]): ReviewFixDrivers {
  let ri = 0, fi = 0;
  return {
    review: async (_p, opts) => {
      state.reviewCalls.push({ sessionId: opts.sessionId, firstCall: opts.firstCall });
      const r = reviewScript[ri++] ?? { verdict: 'LGTM', findings: [] };
      return {
        ok: r.ok ?? true,
        text: r.parseFail ? 'oops, this is not JSON {{{' : JSON.stringify({ verdict: r.verdict ?? 'LGTM', findings: r.findings ?? [] }),
        sessionId: r.sessionId === undefined ? 'codex-sid' : r.sessionId,
        available: r.available ?? true,
        used: r.used ?? 'codex',
        error: r.ok === false ? 'boom' : undefined,
      };
    },
    fix: async (_p, opts) => {
      state.fixCalls.push({ sessionId: opts.sessionId });
      const f = fixScript[fi++] ?? {};
      return {
        ok: f.ok ?? true,
        text: f.badText ? 'a revision with broken JSON {{{' : JSON.stringify({ artifact: f.artifact ?? { v: fi }, needs_human: f.needsHuman ?? [] }),
        sessionId: f.sessionId === undefined ? 'claude-sid' : f.sessionId,
        costUsd: f.costUsd ?? 0.01,
      };
    },
  };
}

test('a clean first round -> resolved, and the reviewer session is captured', async () => {
  const st = mkState();
  const out = await runReviewFixLoop(mkCfg(st), mkDrivers(st, [{ verdict: 'LGTM', findings: [] }], []));
  assert.equal(out.resolved, true);
  assert.equal(out.round, 1);
  assert.equal(st.reviewerSession, 'codex-sid');
  assert.equal(st.fixCalls.length, 0);
});

test('needs_revision -> the revision escalates needs_human -> pause and wait for a human', async () => {
  const st = mkState();
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ issue: 'x' }] }], [{ artifact: { v: 1 }, needsHuman: [{ id: 'H1', question: 'q' }] }]));
  assert.equal(out.resolved, false);
  assert.equal(out.stalled, false);
  assert.equal(out.paused, false);
  assert.equal(out.needsHuman?.length, 1);
  assert.equal(st.fixerSession, 'claude-sid');
  assert.equal(st.persists, 1); // the revised draft was persisted
});

test('converging in two rounds: needs_revision -> revise -> clean, with the second round\'s reviewer resuming (the session is reused)', async () => {
  const st = mkState();
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }, { verdict: 'LGTM', findings: [] }], [{ artifact: { v: 1 }, needsHuman: [] }]));
  assert.equal(out.resolved, true);
  assert.equal(out.round, 2);
  assert.equal(st.reviewCalls[0].firstCall, true);
  assert.equal(st.reviewCalls[1].firstCall, false); // the second round resumes
  assert.equal(st.reviewCalls[1].sessionId, 'codex-sid'); // reusing the same session
  assert.equal(st.fixCalls[0].sessionId, null); // the first fix opens a new session
});

test('still unresolved at the hard cap -> stalled, with the residue persisted', async () => {
  const st = mkState({ maxRounds: 2 });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }, { verdict: 'CHANGES_REQUESTED', findings: [{ i: 2 }, { i: 3 }] }], [{ artifact: { v: 1 }, needsHuman: [] }]));
  assert.equal(out.stalled, true);
  assert.equal(out.round, 2);
  assert.equal(st.residual?.round, 2);
  assert.equal(st.residual?.findings.length, 2);
});

test('reaching the per-tick cap -> paused (it transitions itself and continues on the next tick)', async () => {
  const st = mkState({ maxRoundsPerTick: 1 });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }, { verdict: 'LGTM', findings: [] }], [{ artifact: { v: 1 }, needsHuman: [] }]));
  assert.equal(out.paused, true);
  assert.equal(out.round, 1);
  assert.equal(st.reviewCalls.length, 1); // it never reached a second review round
});

test('the reviewer is unavailable (on_missing=skip) -> resolved with verdict "unknown", and the draft is not lost', async () => {
  const st = mkState();
  const out = await runReviewFixLoop(mkCfg(st), mkDrivers(st, [{ available: false }], []));
  assert.equal(out.resolved, true);
  assert.equal(out.verdict, 'unknown');
  assert.equal(st.round, 0); // no round is counted
});

test('the reviewer call fails (available but !ok) -> throw (the worker parks; it is never let through silently)', async () => {
  const st = mkState();
  await assert.rejects(
    () => runReviewFixLoop(mkCfg(st), mkDrivers(st, [{ ok: false, available: true }], [])),
    /review call failed/,
  );
});

test('the reviewer output cannot be parsed -> throw (it is never silently treated as approved)', async () => {
  const st = mkState();
  await assert.rejects(
    () => runReviewFixLoop(mkCfg(st), mkDrivers(st, [{ parseFail: true }], [])),
    /failed to parse/,
  );
});

test('resuming: with a human answer present it fixes first - even if the reviewer then says clean, the answer has already landed in the artifact (the core regression)', async () => {
  const st = mkState({ humanAnswer: 'M: refund as store credit' });
  // the reviewer says clean on the very first round: without fix-first, the answer would be consumed without ever changing the draft
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'LGTM', findings: [] }], [{ artifact: { v: 99 }, needsHuman: [] }]));
  assert.equal(out.resolved, true);
  assert.equal(st.fixCalls.length, 1); // the fixer was called (fix-first)
  assert.equal(st.fixHumanAnswers[0], 'M: refund as store credit'); // the answer reached the fixer
  assert.equal(st.persists, 1); // the artifact was persisted
  assert.deepEqual(st.artifact, { v: 99 }); // what was persisted is the fixer's revised draft
  assert.equal(st.humanAnswer, null); // only cleared after it succeeded
});

test('resuming: the owner\'s decision lands first, the review findings are then revised as well, and the decision is not fed again into the second fix', async () => {
  const st = mkState({ humanAnswer: 'M: accept store-credit refunds, and add idempotency acceptance' });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(
      st,
      [
        { verdict: 'CHANGES_REQUESTED', findings: [{ issue: 'refund idempotency acceptance is missing' }] },
        { verdict: 'LGTM', findings: [] },
      ],
      [
        { artifact: { v: 10 }, needsHuman: [] }, // apply the owner's decision first
        { artifact: { v: 11 }, needsHuman: [] }, // then work through the review findings
      ],
    ));
  assert.equal(out.resolved, true);
  assert.deepEqual(st.artifact, { v: 11 });
  assert.deepEqual(st.fixHumanAnswers, ['M: accept store-credit refunds, and add idempotency acceptance', null]);
  assert.equal(st.persists, 2);
  assert.equal(st.humanAnswer, null);
});

test('resuming: it fixes first under on_missing=skip too (an unavailable reviewer must not throw the answer away)', async () => {
  const st = mkState({ humanAnswer: 'M: refund as store credit' });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ available: false }], [{ artifact: { v: 7 }, needsHuman: [] }]));
  assert.equal(out.resolved, true);
  assert.equal(st.fixCalls.length, 1);
  assert.equal(st.persists, 1);
  assert.deepEqual(st.artifact, { v: 7 });
});

test('resuming: the fix-first call fails -> paused, and humanAnswer is not cleared (the next tick retries and the answer is not lost)', async () => {
  const st = mkState({ humanAnswer: 'M: refund as store credit' });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'LGTM', findings: [] }], [{ ok: false }]));
  assert.equal(out.paused, true);
  assert.equal(st.humanAnswer, 'M: refund as store credit'); // not cleared -> the next tick retries
  assert.equal(st.persists, 0);
});

test('resuming: fix-first raises a fresh needs_human -> park again (the answer landed, and it escalates once more)', async () => {
  const st = mkState({ humanAnswer: 'M: partially accepted' });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [], [{ artifact: { v: 5 }, needsHuman: [{ id: 'H2', question: 'then what is the refund window?' }] }]));
  assert.equal(out.needsHuman?.length, 1);
  assert.equal(st.persists, 1); // the artifact was persisted
  assert.equal(st.humanAnswer, null); // the old answer was consumed
});

test('resuming: the fix-first output is broken JSON -> throw, without clearing humanAnswer and without falling back (the core regression)', async () => {
  const st = mkState({ humanAnswer: 'M: refund as store credit' });
  await assert.rejects(
    () => runReviewFixLoop(mkCfg(st), mkDrivers(st, [{ verdict: 'LGTM', findings: [] }], [{ badText: true }])),
    /failed to parse/,
  );
  assert.equal(st.humanAnswer, 'M: refund as store credit'); // not cleared -> the retry applies it again
  assert.equal(st.persists, 0); // it never falls back to the old draft
});

test('resuming: the first fix-first output is broken JSON -> self-heal by resuming **the same fixer session** for a re-emit -> good (the answer is only cleared once it has landed)', async () => {
  // The invariant: a successful fix-first call pins the fixer session (setFixerSession), so the self-healing
  // re-emit resumes that same session - otherwise the re-emit would open a new session and lose the owner's
  // answer that the first call carried in. The answer is only cleared once it has been persisted successfully.
  const st = mkState({ humanAnswer: 'M: refund as store credit', maxParseRepairRetries: 1 });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'LGTM', findings: [] }], [{ badText: true }, { artifact: { v: 88 } }]));
  assert.equal(out.resolved, true);
  assert.equal(st.fixCalls.length, 2); // fix-first plus one self-healing re-emit
  assert.equal(st.fixCalls[0].sessionId, null); // the first call opens a new session
  assert.equal(st.fixCalls[1].sessionId, 'claude-sid'); // the key point: the self-heal resumes the same fixer session (so the answer's context is not lost)
  assert.deepEqual(st.artifact, { v: 88 }); // what is persisted is the re-emitted draft
  assert.equal(st.persists, 1);
  assert.equal(st.humanAnswer, null); // only cleared once it persisted successfully
});

test('the revision output is broken JSON (inside the loop) -> throw (the old draft is never silently kept and let through)', async () => {
  const st = mkState();
  await assert.rejects(
    () => runReviewFixLoop(mkCfg(st), mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }], [{ badText: true }])),
    /failed to parse/,
  );
  assert.equal(st.persists, 0);
  assert.equal(st.round, 0); // a bad output is not a valid revision round, so it must not consume one
});

test('the human answer is carried into the first fix only, and is null thereafter', async () => {
  const st = mkState({ humanAnswer: 'M says refund via the original route' });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st,
      [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }, { verdict: 'CHANGES_REQUESTED', findings: [{ i: 2 }] }, { verdict: 'LGTM', findings: [] }],
      [{ artifact: { v: 1 }, needsHuman: [] }, { artifact: { v: 2 }, needsHuman: [] }]));
  assert.equal(out.resolved, true);
  assert.equal(st.fixHumanAnswers[0], 'M says refund via the original route');
  assert.equal(st.fixHumanAnswers[1], null);
});

test('the revision call fails -> paused, without advancing the round (so a transient fault is not miscounted as several unresolved rounds)', async () => {
  const st = mkState();
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }], [{ ok: false }]));
  assert.equal(out.paused, true);
  assert.equal(st.persists, 0); // the revision failed, so nothing was persisted
  assert.equal(st.round, 0); // the key point: a failed round does not count, and the next tick reviews the same round number again
});

test('circuit breaker: consecutive fix-call failures reaching maxFixFailures -> stalled (never spin forever in paused; the same maxAttempts / circuit-breaker practice used elsewhere)', async () => {
  const st = mkState({ maxFixFailures: 3 }); // the streak lives in state and accumulates across "ticks"
  // tick 1: review CHANGES -> fix ok:false -> paused, streak 1
  let out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }], [{ ok: false }]));
  assert.equal(out.paused, true); assert.equal(out.stalled, false); assert.equal(st.fixFailStreak, 1);
  // tick 2: it fails again -> paused, streak 2
  out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }], [{ ok: false }]));
  assert.equal(out.paused, true); assert.equal(st.fixFailStreak, 2);
  // tick 3: the cap is reached -> the breaker trips into stalled (handed to a human) and the residue is persisted
  out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }, { i: 2 }] }], [{ ok: false }]));
  assert.equal(out.stalled, true);
  assert.equal(out.paused, false);
  assert.equal(st.fixFailStreak, 3);
  assert.ok(st.events.some((e) => e.k === 'stalled_fix_failures')); // an explicit breaker event
  assert.equal(st.residual?.findings.length, 2); // the residue is persisted for a human to arbitrate
  assert.equal(st.round, 0); // failures never advance the round (orthogonal to maxRounds; the breaker is an independent backstop)
});

test('circuit breaker: a fix that persists successfully -> the consecutive-failure count resets (the circuit closes again)', async () => {
  const st = mkState({ maxFixFailures: 3 });
  await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }], [{ ok: false }]));
  assert.equal(st.fixFailStreak, 1); // one failure accumulated first
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }, { verdict: 'LGTM', findings: [] }], [{ artifact: { v: 1 }, needsHuman: [] }]));
  assert.equal(out.resolved, true);
  assert.equal(st.fixFailStreak, 0); // success resets it, so a stale streak cannot trip the breaker later
});

// -- Self-healing: a parse failure resumes the same session and feeds it back for a re-emit --
test('self-healing: the verdict is bad once -> resume and resend -> good (it passes in the end, after a second review call)', async () => {
  const st = mkState({ maxParseRepairRetries: 1 });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ parseFail: true }, { verdict: 'LGTM', findings: [] }], []));
  assert.equal(out.resolved, true);
  assert.equal(out.verdict, 'LGTM');
  assert.equal(st.reviewCalls.length, 2); // the initial review plus one self-healing resend
  assert.equal(st.reviewCalls[1].firstCall, false); // the self-heal resumes
  assert.ok(st.events.some((e) => e.k === 'parse_repair_attempt'));
});

test('self-healing: the FixResult is bad once -> resume and resend -> good (the revision persists and it converges)', async () => {
  const st = mkState({ maxParseRepairRetries: 1 });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st,
      [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }, { verdict: 'LGTM', findings: [] }],
      [{ badText: true }, { artifact: { v: 42 } }]));
  assert.equal(out.resolved, true);
  assert.equal(st.fixCalls.length, 2); // the revision plus one self-healing resend
  assert.equal(st.fixCalls[1].sessionId, 'claude-sid'); // the self-heal resumes the same fixer session
  assert.deepEqual(st.artifact, { v: 42 });
});

test('self-healing: still bad once the retries are exhausted -> throw and park (never let through silently)', async () => {
  const st = mkState({ maxParseRepairRetries: 1 });
  await assert.rejects(
    () => runReviewFixLoop(mkCfg(st), mkDrivers(st, [{ parseFail: true }, { parseFail: true }], [])),
    /failed to parse/,
  );
  assert.equal(st.reviewCalls.length, 2); // the initial review plus one self-heal, both bad -> throw
  assert.ok(st.events.some((e) => e.k === 'parse_repair_exhausted'));
});

test('self-healing: the re-emit call keeps failing (null) -> throw after the inner bounded retries (so a single blip no longer ends it)', async () => {
  const st = mkState({ maxParseRepairRetries: 2 });
  // The initial review returns broken JSON, and every re-emit call afterwards is ok:false (null). The inner
  // reEmitCallRetries defaults to 2, so one repair round calls the re-emit 3 times and only then throws.
  await assert.rejects(
    () => runReviewFixLoop(
      mkCfg(st),
      mkDrivers(st, [{ parseFail: true }, { ok: false, available: true }, { ok: false, available: true }, { ok: false, available: true }], []),
    ),
    /failed to parse/,
  );
  assert.equal(st.reviewCalls.length, 4); // 1 initial review + 3 re-emit attempts (callRetries + 1)
  assert.ok(st.events.some((e) => e.k === 'parse_repair_reemit_failed'));
  assert.ok(st.events.some((e) => e.k === 'parse_repair_no_reemit'));
});

test('self-healing: the re-emit call fails transiently (null) and then succeeds -> the self-heal carries on without parking', async () => {
  const st = mkState({ maxParseRepairRetries: 2 });
  // The initial review returns broken JSON -> the first re-emit is ok:false (a transient failure) -> after the
  // backoff the second returns LGTM (the self-heal succeeds).
  const out = await runReviewFixLoop(
    mkCfg(st),
    mkDrivers(st, [{ parseFail: true }, { ok: false, available: true }, { verdict: 'LGTM', findings: [] }], []),
  );
  assert.equal(out.resolved, true);
  assert.equal(st.reviewCalls.length, 3); // the initial review + 1 failure + 1 success
  assert.ok(st.events.some((e) => e.k === 'parse_repair_reemit_failed'));
});
