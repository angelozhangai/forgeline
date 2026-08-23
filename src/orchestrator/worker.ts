import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { hours } from '../util/time.ts';
import { STATE_DIR } from '../root.ts';
import { store as sessions } from '../store/index.ts'; // through the SessionStore seam (the selection point), never directly from store/sessions.ts
import { jobSource } from './jobs/index.ts'; // the control-plane / runner boundary seam: the tick takes due jobs through this rather than enumerating the DB itself
import type { State } from '../statemachine/states.ts';
import { runGateA, runGateARevision } from '../gates/gateA.ts';
import type { GateAOutcome } from '../gates/gateA.ts';
import { runGateB, finalizeGateBDoc } from '../gates/gateB.ts';
import { runGateBLoop } from '../gates/gateBLoop.ts';
import { runGateALoop, readGateAEnvelope } from '../gates/gateALoop.ts';
import { runGateCSetup, activateLeg, activeLeg } from '../gates/gateC.ts';
import { getLegs, patchLeg, planLegAdvance, planGateDAdvance } from '../gates/legs.ts';
import { runGateCLoop } from '../gates/gateCLoop.ts';
import { openReviewPr } from '../gates/gateD.ts';
import { runGateDLoop, MAX_CI_FIX_ATTEMPTS } from '../gates/gateDLoop.ts';
import { runGateDHarden } from '../gates/gateDHarden.ts';
import { writePrdTruth } from '../gates/prdTruth.ts';
import { worktreeHeadSha } from '../util/worktree.ts';
import { reconcileDrift } from '../drift/reconcile.ts';
import type { ReviewFixOutcome } from '../review/reviewFixLoop.ts';
import { markReviewActive, autoAssignOnGo, requestGateB, go, requestGateC, requestReviewPr } from '../actions.ts';
import type { ActionResult } from '../actions.ts';
import { autoActionFor, AUTONOMY_GATES, type AutoAction } from '../statemachine/autonomyPolicy.ts';
import { maybeCommitDeliveryDocs } from '../writes.ts';
import { projectForSession, project, defaultProjectId } from '../projects.ts';
import { listWorktrees, removeWorktree, deleteBranch, planWorktreeSweep } from '../util/worktree.ts';
import { runLimited } from './queue.ts';
import { classifyError, backoffMs, maxAutoRetries, maxReclaims, planRetry } from './retry.ts';
import { loadConfig } from '../config.ts';
import type { RuntimeConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { notify, syncGroupCard } from '../notify.ts';
import type { NotifyKind } from '../notify.ts';
import type { Session } from '../types.ts';
import { fireTickStart, fireTickEnd } from '../ext/index.ts';

// -- One place to park a step failure: classify it, and for a transient one schedule an automatic retry with a
//    backoff (moving to the dead-letter queue once those are exhausted); for a permanent one park immediately
//    and wait for a human. --
// This replaced the old "always transition(*_FAILED) + notify", separating an infrastructure wobble from a
// semantic failure.
async function parkFailure(
  id: string,
  failState: State,
  stages: { event: string; label: string },
  err: unknown,
): Promise<void> {
  const s = (await sessions.get(id))!;
  const klass = classifyError(err);
  const msg = String(err).slice(0, 500);
  const tries = s.retry_count ?? 0;

  // Transient, under the cap, and not dead-lettered -> schedule an automatic retry with a backoff (no
  // notification, to avoid noise; a later tick's reconcile picks it up once the backoff expires).
  if (klass === 'transient' && tries < maxAutoRetries() && !s.dead_letter) {
    const attempt = tries + 1;
    const delay = backoffMs(attempt);
    await sessions.transition(id, failState, { error: msg, retry_count: attempt, next_retry_at: Date.now() + delay });
    await sessions.appendEvent(id, 'retry_scheduled', { stage: stages.event, attempt, max: maxAutoRetries(), klass, delay_ms: delay });
    log.warn(`${s.slug}: ${stages.label} failed transiently (attempt ${attempt}/${maxAutoRetries()}) -> retrying automatically in ${Math.round(delay / 1000)}s - ${msg.slice(0, 120)}`);
    return;
  }

  // Permanent, or a transient whose retries are exhausted -> park and wait for a human. An exhausted transient
  // is marked dead-letter (automation has given up; a manual retry clears it).
  const exhausted = klass === 'transient' && tries >= maxAutoRetries();
  await sessions.transition(id, failState, { error: msg, next_retry_at: null, ...(exhausted ? { dead_letter: 1 } : {}) });
  await sessions.appendEvent(id, 'error', { stage: stages.event, msg: String(err), klass, dead_letter: exhausted ? 1 : 0 });
  log.err(`${s.slug}: ${stages.label} failed (${klass}${exhausted ? ', retries exhausted -> dead letter' : ''}) - ${msg.slice(0, 160)}`);
  await notify('failed', (await sessions.get(id))!, { stage: stages.label, error: String(err) });
}

// Advancing successfully clears the retry bookkeeping (so the next failure counts from zero, and the poison-pill
// counter resets). It only writes when there is bookkeeping to clear, avoiding a pointless UPDATE.
async function clearRetry(id: string): Promise<void> {
  const s = (await sessions.get(id))!;
  if (s.retry_count || s.next_retry_at || s.reclaim_count || s.dead_letter) {
    await sessions.patch(id, { retry_count: null, next_retry_at: null, reclaim_count: null, dead_letter: null });
  }
}

// One Gate A round (the first, or a re-review) has finished; transition on its conclusion: nothing left open ->
// enter the codex adversarial re-review; at the cap -> GATE_A_STALLED; otherwise wait for the PM's next round.
async function afterGateA(id: string, outcome: GateAOutcome): Promise<void> {
  const s = (await sessions.get(id))!;
  if (outcome.resolved) {
    // The PM loop has no open questions left -> do not confirm directly; first pass a codex adversarial
    // re-review (it keeps going until that passes, and only then is it CONFIRMED).
    // Entering the adversarial phase writes gate_a_adv_round=0 as a marker: if the very first codex call fails
    // (before any round is counted or a thread started), a retry can still use it to continue the adversarial
    // loop in place rather than falling back to INTAKE, re-running all of Gate A and bothering the PM again -
    // see planRetry.
    await sessions.transition(id, 'GATE_A_ADVERSARIAL', { gate_a_adv_round: 0 });
    await sessions.appendEvent(id, 'gate_a_resolved', { round: outcome.round });
    log.ok(`${s.slug}: Gate A round ${outcome.round} left no open questions -> entering the codex adversarial re-review`);
    await syncGroupCard((await sessions.get(id))!);
    return;
  }
  if (outcome.stalled) {
    await sessions.transition(id, 'GATE_A_STALLED');
    await sessions.appendEvent(id, 'gate_a_stalled', { round: outcome.round, open_questions: outcome.openQuestions });
    log.warn(`${s.slug}: after ${outcome.round - 1} rounds of PM review, Gate A still has ${outcome.openQuestions} unresolved question(s) -> parking for the owner to arbitrate`);
    await notify('needs_arbitration', (await sessions.get(id))!);
    return;
  }
  await sessions.transition(id, 'AWAITING_PM_CONFIRM');
  await sessions.appendEvent(id, 'gate_a_done', { round: outcome.round, open_questions: outcome.openQuestions });
  log.ok(`${s.slug}: Gate A round ${outcome.round} finished (${outcome.openQuestions} question(s) for the PM) -> awaiting the PM's confirmation`);
  await notify('needs_confirm', (await sessions.get(id))!);
}

// The Gate B codex-reviews / claude-revises loop has run to its next resting point; transition on its
// conclusion: clean -> await GO; the revision escalated -> await the owner's answer; at the cap -> park for
// arbitration; the per-tick cap or a retry -> stay in the loop state and continue next tick.
async function afterGateB(id: string, outcome: ReviewFixOutcome): Promise<void> {
  const s = (await sessions.get(id))!;
  if (outcome.paused) {
    // Stay in ADVERSARIAL_LOOP (poller-driven, so the next tick continues automatically); no notification, to
    // avoid noise.
    await sessions.appendEvent(id, 'gateb_loop_paused', { round: outcome.round });
    log.info(`${s.slug}: Gate B adversarial round ${outcome.round} paused (the per-tick cap, or a retry) -> continuing next tick`);
    return;
  }
  if (outcome.resolved) {
    // The re-review passed -> clear any stale parked findings a "revise once more" round may have left behind
    // (only now is there a new conclusion; the failure paths do not come through here, so their residue is kept
    // as evidence).
    await sessions.patch(id, { adversarial_residual: null });
    finalizeGateBDoc((await sessions.get(id))!);
    await sessions.transition(id, 'AWAITING_GO');
    await sessions.appendEvent(id, 'gate_b_done', { round: outcome.round, verdict: outcome.verdict });
    log.ok(`${s.slug}: the Gate B codex-reviews / claude-revises loop passed in round ${outcome.round} -> awaiting GO`);
    // Compute and persist the automatic assignment recommendation (best-effort), so the GO card can show the
    // suggested DRI alongside everyone's current load.
    await autoAssignOnGo(id);
    await notify('needs_go', (await sessions.get(id))!);
    return;
  }
  if (outcome.needsHuman) {
    await sessions.patch(id, { gate_b_human_asks: JSON.stringify(outcome.needsHuman) });
    await sessions.transition(id, 'AWAITING_GATE_B_INPUT');
    await sessions.appendEvent(id, 'gate_b_needs_human', { round: outcome.round, count: outcome.needsHuman.length });
    log.warn(`${s.slug}: the Gate B revision escalated ${outcome.needsHuman.length} question(s) in round ${outcome.round} -> awaiting the owner's answer`);
    await notify('needs_gateb_input', (await sessions.get(id))!);
    return;
  }
  if (outcome.stalled) {
    finalizeGateBDoc((await sessions.get(id))!);
    await sessions.transition(id, 'GATE_B_STALLED');
    await sessions.appendEvent(id, 'gate_b_stalled', { round: outcome.round, findings: outcome.unresolvedFindings.length });
    log.warn(`${s.slug}: after ${outcome.round} Gate B adversarial rounds, ${outcome.unresolvedFindings.length} finding(s) are still unresolved -> parking for the owner to arbitrate`);
    await notify('needs_gateb_arbitration', (await sessions.get(id))!);
  }
}

// The Gate A codex-reviews / claude-revises adversarial loop has run to its next resting point; transition on
// its conclusion: LGTM -> CONFIRMED (on to Gate B); at the cap -> park for arbitration; the per-tick cap or a
// retry -> stay in the loop state. Gate A never escalates to a human in the loop (it has no needsHuman).
async function afterGateAAdversarial(id: string, outcome: ReviewFixOutcome): Promise<void> {
  const s = (await sessions.get(id))!;
  if (outcome.paused) {
    await sessions.appendEvent(id, 'gatea_loop_paused', { round: outcome.round });
    log.info(`${s.slug}: Gate A adversarial round ${outcome.round} paused (the per-tick cap, or a retry) -> continuing next tick`);
    return;
  }
  if (outcome.resolved) {
    // The codex adversarial re-review may add new open_questions for points that were never asked
    // (gate-a-fix.md requires exactly that) - and those are questions the PM has not answered yet.
    // If there are any, it must never auto-confirm into Gate B (that unanswered-question-to-implementation-drift
    // path is precisely what this closes): void this adversarial round, reset its bookkeeping, and bounce back
    // to the PM. The PM answers -> the Gate A re-review empties open_questions -> a fresh adversarial round
    // starts.
    const env = readGateAEnvelope((await sessions.get(id))!);
    if (env.open_questions.length > 0) {
      await sessions.transition(id, 'AWAITING_PM_CONFIRM', {
        gate_a_adv_round: null,
        gate_a_reviewer_session: null,
        gate_a_fixer_session: null,
        gate_a_residual: null,
      });
      await sessions.appendEvent(id, 'gatea_adv_reopened', { round: outcome.round, open_questions: env.open_questions.length });
      log.warn(`${s.slug}: Gate A adversarial round ${outcome.round} surfaced ${env.open_questions.length} question(s) the PM has not answered -> bouncing back to the PM (no automatic confirmation)`);
      await notify('needs_confirm', (await sessions.get(id))!);
      return;
    }
    await sessions.patch(id, { gate_a_residual: null }); // clear any stale codex findings left over from a park-for-arbitration round
    markReviewActive(projectForSession(s).deliveryDir, s.slug);
    const note = 'the Gate A review and the AI adversarial re-review both passed; confirmed automatically';
    await sessions.transition(id, 'CONFIRMED', {
      confirmed_by: 'AI',
      confirmed_at: Date.now(),
      confirmed_notes: s.confirmed_notes ? `${s.confirmed_notes}\n[Gate A] ${note}` : note,
    });
    await sessions.appendEvent(id, 'gatea_adv_resolved', { round: outcome.round, verdict: outcome.verdict });
    // Seal it: mechanically synthesise "reviewed over several rounds + confirmed by the PM" into prd-truth.md
    // (Gate B's only requirement input). Best-effort - a failure does not block the confirmation, because Gate
    // B's loadPrdTruth synthesises a fallback on the spot.
    try {
      if (writePrdTruth((await sessions.get(id))!)) await sessions.appendEvent(id, 'prd_truth_written', { at: 'gate_a_adversarial' });
    } catch (e) {
      log.warn(`${s.slug}: sealing the PRD source of truth to disk failed (Gate B will rebuild it as a fallback) - ${String(e).slice(0, 120)}`);
    }
    log.ok(`${s.slug}: the Gate A codex adversarial review passed in round ${outcome.round} -> confirmed`);
    await notify('needs_gateb', (await sessions.get(id))!);
    return;
  }
  if (outcome.stalled) {
    // The residue (codex's findings) has already been written to gate_a_residual by the loop's persistResidual;
    // hand it to the owner to arbitrate.
    await sessions.transition(id, 'GATE_A_STALLED');
    await sessions.appendEvent(id, 'gatea_adv_stalled', { round: outcome.round, findings: outcome.unresolvedFindings.length });
    log.warn(`${s.slug}: after ${outcome.round} Gate A adversarial rounds, ${outcome.unresolvedFindings.length} finding(s) are still unresolved -> parking for the owner to arbitrate`);
    await notify('needs_arbitration', (await sessions.get(id))!);
  }
}

// Run the Gate A adversarial loop and transition on its conclusion; any failure goes through parkFailure (a
// transient one backs off and retries automatically, a permanent one parks at GATE_A_FAILED).
async function runGateALoopStep(id: string, stage: string): Promise<void> {
  try {
    const outcome = await runGateALoop((await sessions.get(id))!);
    await afterGateAAdversarial(id, outcome);
    await clearRetry(id);
  } catch (e) {
    await parkFailure(id, 'GATE_A_FAILED', { event: stage, label: 'the Gate A adversarial review' }, e);
  }
}

// Run the Gate B adversarial loop and transition on its conclusion; any failure goes through parkFailure (a
// transient one backs off and retries automatically, a permanent one parks at GATE_B_FAILED).
async function runGateBLoopStep(id: string, stage: string): Promise<void> {
  try {
    const outcome = await runGateBLoop((await sessions.get(id))!);
    await afterGateB(id, outcome);
    await clearRetry(id); // reaching a resting point (including a paused continuation) counts as progress, so the retry bookkeeping is cleared
  } catch (e) {
    await parkFailure(id, 'GATE_B_FAILED', { event: stage, label: 'the Gate B adversarial review' }, e);
  }
}

// The Gate C implement/CI loop has run to its next resting point; transition on its conclusion: green ->
// AWAITING_GATE_D (awaiting the PR); an escalation -> await the owner's answer; at the cap -> park for
// arbitration; the per-tick cap or a retry -> stay in the loop state.
async function afterGateC(id: string, outcome: ReviewFixOutcome): Promise<void> {
  const s = (await sessions.get(id))!;
  if (outcome.paused) {
    await sessions.appendEvent(id, 'gatec_loop_paused', { round: outcome.round });
    log.info(`${s.slug}: Gate C implementation round ${outcome.round} paused (the per-tick cap, or a retry) -> continuing next tick`);
    return;
  }
  if (outcome.resolved) {
    await sessions.patch(id, { gate_c_residual: null });
    // Multi-repo sequential driving: the current leg's CI is green -> mark it; if a leg is still not green ->
    // activate it and continue (staying in GATE_C_LOOP); only once every leg is green does it enter
    // AWAITING_GATE_D.
    // A single repo is exactly one leg, so it goes straight to AWAITING_GATE_D. With no legs (an older
    // in-flight session) activeLeg is null and it advances the same way.
    const active = activeLeg((await sessions.get(id))!);
    const { nextRepo } = planLegAdvance(getLegs((await sessions.get(id))!), active?.repo ?? null);
    if (active) await patchLeg((await sessions.get(id))!, active.repo, { ci_ok: true });
    if (nextRepo) {
      const next = getLegs((await sessions.get(id))!).find((l) => l.repo === nextRepo);
      if (next) await activateLeg((await sessions.get(id))!, next);
      await sessions.appendEvent(id, 'gate_c_leg_done', { repo: active?.repo ?? null, round: outcome.round, next: nextRepo });
      log.ok(`${s.slug}: Gate C repo ${active?.repo} went CI-green locally (round ${outcome.round}) -> switching to ${nextRepo} to continue implementing (GATE_C_LOOP)`);
      return; // stay in GATE_C_LOOP; the next tick runs the next leg
    }
    await sessions.transition(id, 'AWAITING_GATE_D');
    await sessions.appendEvent(id, 'gate_c_done', { round: outcome.round, repos: getLegs((await sessions.get(id))!).map((l) => l.repo) });
    log.ok(`${s.slug}: every Gate C target repo is CI-green locally -> awaiting the review PR`);
    await notify('needs_review_pr', (await sessions.get(id))!);
    return;
  }
  if (outcome.needsHuman) {
    await sessions.patch(id, { gate_c_human_asks: JSON.stringify(outcome.needsHuman) });
    await sessions.transition(id, 'AWAITING_GATE_C_INPUT');
    await sessions.appendEvent(id, 'gate_c_needs_human', { round: outcome.round, count: outcome.needsHuman.length });
    log.warn(`${s.slug}: the Gate C implementation escalated ${outcome.needsHuman.length} question(s) in round ${outcome.round} -> awaiting the owner's answer`);
    await notify('needs_gatec_input', (await sessions.get(id))!);
    return;
  }
  if (outcome.stalled) {
    await sessions.transition(id, 'GATE_C_STALLED');
    await sessions.appendEvent(id, 'gate_c_stalled', { round: outcome.round });
    log.warn(`${s.slug}: after ${outcome.round} Gate C rounds the local CI and acceptance are still not fully green -> parking for the owner to arbitrate`);
    await notify('needs_gatec_arbitration', (await sessions.get(id))!);
  }
}

// Run the Gate C implementation loop and transition on its conclusion; any failure goes through parkFailure (a
// transient one backs off and retries automatically, a permanent one parks at GATE_C_FAILED).
async function runGateCLoopStep(id: string, stage: string): Promise<void> {
  try {
    const outcome = await runGateCLoop((await sessions.get(id))!);
    await afterGateC(id, outcome);
    await clearRetry(id);
  } catch (e) {
    await parkFailure(id, 'GATE_C_FAILED', { event: stage, label: 'the Gate C implementation' }, e);
  }
}

// The Gate D PR adversarial loop has run to its next resting point; transition on its conclusion: LGTM ->
// GATE_D_HARDENING (adding the inner-loop tests); an escalation -> await the owner's answer; at the cap -> park
// for arbitration; the per-tick cap or a retry -> stay in the loop state.
async function afterGateD(id: string, outcome: ReviewFixOutcome): Promise<void> {
  const s = (await sessions.get(id))!;
  if (outcome.paused) {
    await sessions.appendEvent(id, 'gated_loop_paused', { round: outcome.round });
    log.info(`${s.slug}: Gate D PR review round ${outcome.round} paused (the per-tick cap, or a retry) -> continuing next tick`);
    return;
  }
  if (outcome.resolved) {
    // **Pin the green state**: right now the worktree HEAD is the commit codex said LGTM to (the last green
    // state the loop pushed, or Gate C's final state).
    // Persisting it gives hardening its baseline - hardening only ever resets to this immutable sha, never to
    // the moving ref origin/<branch> (otherwise what gets hardened, CI-verified and pushed may not be what codex
    // reviewed - a Codex blocker). If it cannot be read, **throw here and park at GATE_D_FAILED**; it must never
    // enter HARDENING (pinning the diagnosis at the point of failure avoids looping through
    // "LGTM -> hardening -> missing sha", Codex second review SF). runGateDLoopStep's catch turns it into a park.
    const greenSha = s.worktree_path ? worktreeHeadSha(s.worktree_path) : null;
    if (!greenSha) throw new Error('Gate D reached LGTM but the worktree green HEAD could not be read (so the hardening baseline cannot be pinned) -> parking rather than entering hardening');
    await sessions.patch(id, { gate_d_residual: null, gate_d_green_sha: greenSha });
    await sessions.transition(id, 'GATE_D_HARDENING');
    await sessions.appendEvent(id, 'gate_d_done', { round: outcome.round, verdict: outcome.verdict, green_sha: greenSha.slice(0, 12) });
    log.ok(`${s.slug}: the Gate D codex-reviews-diff / claude-revises loop passed in round ${outcome.round} -> entering test hardening (GATE_D_HARDENING)`);
    return; // the next tick's step(GATE_D_HARDENING) runs the hardening (poller-driven)
  }
  if (outcome.needsHuman) {
    await sessions.patch(id, { gate_d_human_asks: JSON.stringify(outcome.needsHuman) });
    await sessions.transition(id, 'AWAITING_GATE_D_INPUT');
    await sessions.appendEvent(id, 'gate_d_needs_human', { round: outcome.round, count: outcome.needsHuman.length });
    log.warn(`${s.slug}: the Gate D revision escalated ${outcome.needsHuman.length} question(s) in round ${outcome.round} -> awaiting the owner's answer`);
    await notify('needs_gated_input', (await sessions.get(id))!);
    return;
  }
  if (outcome.stalled) {
    await sessions.transition(id, 'GATE_D_STALLED');
    await sessions.appendEvent(id, 'gate_d_stalled', { round: outcome.round, findings: outcome.unresolvedFindings.length });
    log.warn(`${s.slug}: after ${outcome.round} Gate D adversarial rounds, ${outcome.unresolvedFindings.length} finding(s) are still unresolved -> parking for the owner to arbitrate`);
    await notify('needs_gated_arbitration', (await sessions.get(id))!);
  }
}

// Run the Gate D PR adversarial loop and transition on its conclusion; any failure goes through parkFailure (a
// transient one backs off and retries automatically, a permanent one parks at GATE_D_FAILED).
async function runGateDLoopStep(id: string, stage: string): Promise<void> {
  try {
    const outcome = await runGateDLoop((await sessions.get(id))!);
    await afterGateD(id, outcome);
    await clearRetry(id);
  } catch (e) {
    await parkFailure(id, 'GATE_D_FAILED', { event: stage, label: 'the Gate D PR review' }, e);
  }
}

// Run the Gate D test hardening (add the inner-loop tests + get CI green + produce merge-readiness + push).
// Multi-repo sequential driving: once the current leg finishes hardening, its Gate D terminal state (the green
// sha, the verified sha, the report, the PR) is persisted back onto the leg; if a leg has not been reviewed yet
// it switches to that one and returns to GATE_D_LOOP (staying in Gate D rather than reaching merge-ready); only
// once every leg has hardened does it reach AWAITING_HUMAN_MERGE (**nothing is ever merged automatically**).
// A single repo is exactly one leg, so it goes straight to merge-ready. With no legs (an older in-flight
// session) activeLeg is null and it does the same.
// Any failure goes through parkFailure to GATE_D_FAILED (planRetry sees gate_d_harden_round > 0 and returns to
// HARDENING to continue, which is idempotent on re-entry; the session-level fields describe the active leg).
async function runGateDHardenStep(id: string, stage: string): Promise<void> {
  try {
    await runGateDHarden((await sessions.get(id))!);
    const sNow = (await sessions.get(id))!;
    const active = activeLeg(sNow);
    // Persist the current leg's Gate D terminal state back onto the leg (a non-empty
    // gate_d_harden_verified_sha means that leg is through Gate D; ackMerged verifies each leg by its own
    // pr_url).
    if (active) {
      await patchLeg(sNow, active.repo, {
        gate_d_round: sNow.gate_d_round,
        gate_d_green_sha: sNow.gate_d_green_sha,
        gate_d_harden_verified_sha: sNow.gate_d_harden_verified_sha,
        merge_readiness_path: sNow.merge_readiness_path,
        pr_url: sNow.pr_url,
        pr_number: sNow.pr_number,
      });
    }
    const { nextRepo } = planGateDAdvance(getLegs((await sessions.get(id))!), active?.repo ?? null);
    if (nextRepo) {
      const next = getLegs((await sessions.get(id))!).find((l) => l.repo === nextRepo);
      if (next) await activateLeg((await sessions.get(id))!, next); // re-point at the next leg: its worktree, envelope, PR and the whole Gate D loop state all align with it
      await sessions.appendEvent(id, 'gate_d_leg_done', { repo: active?.repo ?? null, next: nextRepo });
      await enterRunning(id, 'GATE_D_LOOP'); // the next leg is reviewed from scratch (activateLeg has already reset its Gate D rounds and sessions)
      await clearRetry(id);
      log.ok(`${(await sessions.get(id))!.slug}: Gate D repo ${active?.repo} finished hardening with a green local CI -> switching to ${nextRepo} for its PR review (GATE_D_LOOP)`);
      return; // stay in Gate D; the next tick reviews the next leg
    }
    await sessions.transition(id, 'AWAITING_HUMAN_MERGE');
    await sessions.appendEvent(id, 'gate_d_hardened', { round: (await sessions.get(id))!.gate_d_harden_round ?? 1, repos: getLegs((await sessions.get(id))!).map((l) => l.repo) });
    await clearRetry(id);
    // Archive the downstream delivery documents (gated by the delivery_doc_commit config, off by default, and
    // it **never pushes**): by now every target repo's merge-readiness*.md has been written under the delivery
    // directory, and they are committed together to the target project's current branch. Best-effort - it
    // swallows its own exceptions internally and must never block reaching merge-ready.
    const dc = await maybeCommitDeliveryDocs((await sessions.get(id))!);
    if (dc.committed) await sessions.appendEvent(id, 'delivery_docs_committed', { slug: (await sessions.get(id))!.slug });
    log.ok(`${(await sessions.get(id))!.slug}: every Gate D target repo finished test hardening with a fully green local CI -> merge-ready (AWAITING_HUMAN_MERGE; nothing is ever merged automatically)`);
    await notify('needs_merge', (await sessions.get(id))!);
  } catch (e) {
    await parkFailure(id, 'GATE_D_FAILED', { event: stage, label: 'the Gate D test hardening' }, e);
  }
}

// Enter a running state: transition and refresh the group card, so the team sees "under review" / "being
// designed" / "under AI review" rather than the stale "queued" text from intake.
// syncGroupCard is best-effort (it has its own try/catch and only applies to chat-sourced sessions); it neither
// blocks nor slows down running the gates.
async function enterRunning(id: string, to: State): Promise<void> {
  await sessions.transition(id, to);
  await syncGroupCard((await sessions.get(id))!);
}

// Run the next step for one ready session. A failure parks it at the matching *_FAILED state; it never throws.
export async function step(s: Session): Promise<void> {
  if (s.state === 'INTAKE') {
    await enterRunning(s.id, 'GATE_A_RUNNING');
    try {
      const outcome = await runGateA((await sessions.get(s.id))!);
      await afterGateA(s.id, outcome);
      await clearRetry(s.id);
    } catch (e) {
      await parkFailure(s.id, 'GATE_A_FAILED', { event: 'gate_a', label: 'Gate A' }, e);
    }
    return;
  }

  // The Gate A re-review (after the PM answers): resume the same session to continue reviewing -> back to the
  // PM, or confirm, or park for arbitration.
  if (s.state === 'GATE_A_REVISION_REQUESTED') {
    await enterRunning(s.id, 'GATE_A_RUNNING');
    try {
      const outcome = await runGateARevision((await sessions.get(s.id))!);
      await afterGateA(s.id, outcome);
      await clearRetry(s.id);
    } catch (e) {
      await parkFailure(s.id, 'GATE_A_FAILED', { event: 'gate_a_revision', label: 'the Gate A re-review' }, e);
    }
    return;
  }

  // The Gate A adversarial re-review: once the PM loop has no open questions, the codex-reviews /
  // claude-revises loop runs to a resting point (poller-driven, continuing after the per-tick cap).
  if (s.state === 'GATE_A_ADVERSARIAL') {
    await runGateALoopStep(s.id, 'gate_a_adversarial');
    return;
  }

  // Gate B: produce the first draft -> enter the codex-reviews / claude-revises adversarial loop (running
  // straight through to the first resting point within this one step).
  if (s.state === 'GATE_B_REQUESTED') {
    await enterRunning(s.id, 'GATE_B_RUNNING');
    try {
      await runGateB((await sessions.get(s.id))!);
    } catch (e) {
      await parkFailure(s.id, 'GATE_B_FAILED', { event: 'gate_b', label: 'Gate B' }, e);
      return;
    }
    await enterRunning(s.id, 'ADVERSARIAL_LOOP');
    await runGateBLoopStep(s.id, 'gate_b_adversarial');
    return;
  }

  // Continuing the adversarial loop: on the next tick after the per-tick cap, or picked up by the poller's
  // self-healing after a tick was interrupted (the draft, the round counter and the sessions are all persisted,
  // so it continues in place).
  if (s.state === 'ADVERSARIAL_LOOP') {
    await runGateBLoopStep(s.id, 'gate_b_adversarial');
    return;
  }

  // Continuing the revision: after the owner answers the escalated questions, resume the revision -> back into
  // the loop for another review.
  if (s.state === 'GATE_B_REVISION_REQUESTED') {
    await enterRunning(s.id, 'ADVERSARIAL_LOOP');
    await runGateBLoopStep(s.id, 'gate_b_revision');
    return;
  }

  // Gate C: create the isolated worktree -> enter the implement/CI loop (running straight through to the first
  // resting point within this one step).
  if (s.state === 'GATE_C_REQUESTED') {
    await enterRunning(s.id, 'GATE_C_RUNNING');
    try {
      await runGateCSetup((await sessions.get(s.id))!);
    } catch (e) {
      await parkFailure(s.id, 'GATE_C_FAILED', { event: 'gate_c_setup', label: 'the Gate C worktree setup' }, e);
      return;
    }
    await enterRunning(s.id, 'GATE_C_LOOP');
    await runGateCLoopStep(s.id, 'gate_c_implement');
    return;
  }

  // Continuing the implementation loop: on the next tick after the per-tick cap, or picked up by the poller's
  // self-healing after a tick was interrupted (the envelope, the round counter and the session are persisted).
  if (s.state === 'GATE_C_LOOP') {
    await runGateCLoopStep(s.id, 'gate_c_implement');
    return;
  }

  // Continuing the work: after the owner answers the escalated implementation questions, resume the work ->
  // back into the loop to run CI again.
  if (s.state === 'GATE_C_REVISION_REQUESTED') {
    await enterRunning(s.id, 'GATE_C_LOOP');
    await runGateCLoopStep(s.id, 'gate_c_revision');
    return;
  }

  // Gate D opens the PR: the project's own create-PR script pushes the branch and opens the PR (nothing is ever
  // merged automatically; the script is idempotent, so re-entering on the next tick after an interruption is
  // safe).
  // On success -> enter GATE_D_LOOP and run codex-reviews-diff / claude-revises; on failure -> park at
  // GATE_D_FAILED.
  if (s.state === 'GATE_D_REQUESTED') {
    try {
      await openReviewPr((await sessions.get(s.id))!);
    } catch (e) {
      await parkFailure(s.id, 'GATE_D_FAILED', { event: 'gate_d_open_pr', label: 'opening the Gate D PR' }, e);
      return;
    }
    // Multi-repo: after openReviewPr has opened N PRs the session still points at the last gate-C leg, so
    // before entering Gate D it **re-points at the primary leg** (activateLeg aligns the worktree, the envelope,
    // pr_url and the whole Gate D loop state with the primary). Otherwise Gate D would review "the last leg's
    // tree" while carrying the primary's PR - the wrong review, and later a wrongly declared SHIPPED (a Codex
    // blocker). With a single repo or no legs nothing changes: the session already points at its only leg.
    {
      const legs = getLegs((await sessions.get(s.id))!);
      if (legs.length > 1) {
        await activateLeg((await sessions.get(s.id))!, legs[0]);
        await sessions.appendEvent(s.id, 'gate_d_leg_active', { repo: legs[0].repo, pr: legs[0].pr_url });
      }
    }
    await enterRunning(s.id, 'GATE_D_LOOP');
    await runGateDLoopStep(s.id, 'gate_d_pr_review');
    return;
  }

  // Continuing the PR adversarial loop: on the next tick after the per-tick cap, or picked up by the poller's
  // self-healing after a tick was interrupted (the envelope, the round counter and both sides' sessions are
  // persisted).
  if (s.state === 'GATE_D_LOOP') {
    await runGateDLoopStep(s.id, 'gate_d_pr_review');
    return;
  }

  // Continuing the revision: after the owner answers the escalated PR-review questions, resume the revision ->
  // back into the loop for another review.
  // The hardening markers are cleared before returning to the loop: any path that falls back from hardening or
  // merge-ready into an adversarial revision must not leave a stale harden_round, green sha or verified sha
  // behind, or the next failure would have planRetry read the old harden_round and wrongly return to HARDENING,
  // skipping the PR adversarial revision (Codex SF). On a normal loop revision these are already null, so
  // clearing them is a no-op.
  if (s.state === 'GATE_D_REVISION_REQUESTED') {
    await sessions.patch(s.id, { gate_d_harden_round: null, gate_d_green_sha: null, gate_d_harden_verified_sha: null, merge_readiness_path: null });
    await enterRunning(s.id, 'GATE_D_LOOP');
    await runGateDLoopStep(s.id, 'gate_d_revision');
    return;
  }

  // Test hardening: after codex says LGTM, add the inner-loop tests, get CI green and produce merge-readiness ->
  // merge-ready (poller-driven; if a tick is interrupted the next one re-enters idempotently).
  if (s.state === 'GATE_D_HARDENING') {
    await runGateDHardenStep(s.id, 'gate_d_hardening');
    return;
  }
}

// -- The tick lock: it stops the scheduler firing overlapping ticks (Gate A can run for minutes, and a new
//    tick must not barge in). --
// FORGE_LOCK can override the lock path (matching root.ts's FORGE_HEARTBEAT / FORGE_WATCHDOG_STATE test
// isolation convention): tick.lock is a **file on disk** under STATE_DIR and is not isolated by
// FORGE_DB=':memory:', so parallel test processes would share one lock file and each wrongly conclude "a tick
// is already running". A test that calls tick() only needs to set its own FORGE_LOCK to be fully independent.
const LOCK = process.env.FORGE_LOCK || resolve(STATE_DIR, 'tick.lock');

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // it exists but we lack permission = still alive
  }
}

// Deciding whether a tick lock is stale: the lock records `pid\nts`. If the process is dead the lock is void;
// if the process is alive but has held the lock for longer than maxHoldMs (a manual tick that appears to have
// hung - a hung daemon is covered by the watchdog's SIGKILL making the pid die, and this closes the remaining
// hole where a hung manual tick would hold the lock forever) it is treated as stale and may be taken over.
export function lockActive(raw: string, now: number, maxHoldMs: number, alive: (pid: number) => boolean): boolean {
  const [pidStr, tsStr] = raw.trim().split(/\s+/);
  const pid = Number(pidStr);
  if (!pid || !alive(pid)) return false; // the process is dead -> the lock is void
  const ts = Number(tsStr) || now; // the old format carried no timestamp -> treat it as now (conservatively: still alive)
  return now - ts < maxHoldMs; // still within max-hold -> a live lock (skip this tick); past it -> presumed hung and may be taken over
}

// max-hold is a generous upper bound on "the longest a single tick may legitimately take", so that a normal
// long tick is not mistaken for a hang while a genuinely hung lock cannot squat forever.
// Upstream gates (reviewing documents): claude_timeout × 6. The downstream Gates C and D (implementing and
// revising in an isolated worktree plus the local CI) can run for a very long time in one tick - their real
// maximum legitimate duration has to be estimated in full, or a long downstream tick would exceed the grace
// period, be mistaken for a hang, and be taken over by the next tick -> the same worktree runs twice (burning
// money and both sides fighting over git). It takes the larger of the two, and never less than an hour.
// (A genuinely hung daemon is covered by the watchdog's SIGKILL making the pid die; this bound exists only to
// leave a takeover path for "a manual tick hung without exiting", so it errs generous.)
//
// The worst-case downstream path for one tick, counting every drv.fix / drv.review call (N = the effective
// per-tick rounds = min(max_rounds, max_rounds_per_tick)):
//   - the fix-first step at the top of reviewFixLoop is one fix block; the main loop runs at most N rounds and
//     for(;;) runs at least once => at most N+1 fix blocks and N+1 reviews
//   - each fix block is parseFixWithRepair: 1 drv.fix plus at most P parse repairs => (1+P) drv.fix calls; a
//     review is (1+P) the same way
//   - each drv.fix (which in Gate D contains the CI self-fix loop) is at most (claude+CI) × (1 +
//     MAX_CI_FIX_ATTEMPTS = K); each review is at most (claude+CI)
//   Total = (N+1)·(1+P)·(claude+CI)·(K+2), where P = parse_repair_retries. The larger of the two gates wins.
//   A pure function, exported for unit tests.
export function lockMaxHoldSec(rt: RuntimeConfig): number {
  const upstream = rt.claude_timeout_sec * 6;
  // The downstream budget only counts when a downstream gate is configured (with none configured there are no
  // downstream ticks, so the takeover window need not be widened).
  let downstream = 0;
  if (rt.gate_c || rt.gate_d) {
    const dsClaude = Math.max(rt.gate_c?.claude_timeout_sec ?? rt.claude_timeout_sec, rt.gate_d?.claude_timeout_sec ?? rt.claude_timeout_sec);
    const dsCi = Math.max(rt.gate_c?.ci_timeout_sec ?? 1800, rt.gate_d?.ci_timeout_sec ?? 1800);
    const p = Math.max(0, rt.parse_repair_retries ?? 2); // the cap on re-emit attempts when a fix or review output fails to parse
    // The effective per-tick rounds (the same rule gateCLoop and gateDLoop use: min(max_rounds,
    // max_rounds_per_tick ?? 1)), taking the larger of the two gates.
    // Raising a downstream max_rounds_per_tick makes a single tick run more rounds, and this bound scales with
    // the configuration accordingly - it never falls back to the fixed-1 underestimate.
    const perTickOf = (g: { max_rounds?: number; max_rounds_per_tick?: number } | undefined, defMax: number): number =>
      g ? Math.max(1, Math.min(Math.max(1, g.max_rounds ?? defMax), g.max_rounds_per_tick ?? 1)) : 0;
    const perTick = Math.max(perTickOf(rt.gate_c, 4), perTickOf(rt.gate_d, 3));
    downstream = (perTick + 1) * (1 + p) * (dsClaude + dsCi) * (MAX_CI_FIX_ATTEMPTS + 2);
  }
  return Math.max(upstream, downstream, 3600);
}
function lockMaxHoldMs(): number {
  return lockMaxHoldSec(loadConfig().runtime) * 1000;
}

// A takeover claim left uncleaned for longer than this is residue from a previous takeover that crashed midway
// (the takeover itself is a sub-millisecond write plus unlink, so crashing inside it is very rare) -> reclaim it.
const CLAIM_STALE_MS = 30_000;

// Acquire the tick lock. Atomicity is the whole point (it stops two processes running step at once -> paying
// twice and both fighting over git in the same worktree):
//  1) the normal case - an atomic exclusive create (`wx`): when the lock does not exist it is taken in one
//     step, ruling out the old race where two fresh acquires both saw "it does not exist" between an
//     existsSync and a writeFileSync and both wrote.
//  2) the lock exists and is live (its holder is alive and within maxHold) -> stand aside.
//  3) it is stale or hung (the holder is dead, or it is past the maxHold bound) -> take it over, but the
//     takeover itself must be atomic: the old "read, judge it stale, overwrite" let two processes both judge it
//     stale, both overwrite and both continue. Instead an exclusively created (`wx`) .claim file arbitrates the
//     right to take over - only the process that wins the claim may replace the lock.
// The lock path is a parameter so it can be unit-tested (defaulting to LOCK).
export function acquireLock(lockPath: string = LOCK): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });
  const stamp = (): string => `${process.pid}\n${Date.now()}`;
  try {
    writeFileSync(lockPath, stamp(), { flag: 'wx' }); // an atomic exclusive create
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  let raw = '';
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    /* just released, or unreadable -> treat it as stale and go through the claim arbitration */
  }
  if (raw && lockActive(raw, Date.now(), lockMaxHoldMs(), pidAlive)) return false; // a live lock -> stand aside
  const claim = `${lockPath}.claim`;
  if (!acquireClaim(claim)) return false; // the right to take over went to someone else -> stand aside
  try {
    log.warn(`Found a stale or hung tick lock (${raw.trim().replace(/\s+/g, ' ') || 'empty or already released'}); taking it over`);
    writeFileSync(lockPath, stamp()); // safe to replace while holding the claim
    return true;
  } finally {
    try {
      unlinkSync(claim);
    } catch {
      /* ignore */
    }
  }
}

// Exclusively claim "the right to take over": a successful `wx` create means it is ours; an existing, fresh
// claim means someone else is taking over, so stand aside; an existing but stale one (residue from a takeover
// that crashed) is reclaimed and then claimed again. Exported for unit tests.
export function acquireClaim(claim: string): boolean {
  try {
    writeFileSync(claim, `${process.pid}\n${Date.now()}`, { flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  let ts = 0;
  try {
    ts = Number(readFileSync(claim, 'utf8').trim().split(/\s+/)[1]) || 0;
  } catch {
    /* a competitor already deleted it -> treat it as stale and reclaim */
  }
  if (ts && Date.now() - ts <= CLAIM_STALE_MS) return false; // someone else is taking over -> stand aside
  try {
    unlinkSync(claim); // reclaim the stale claim left by a crash
    writeFileSync(claim, `${process.pid}\n${Date.now()}`, { flag: 'wx' });
    return true;
  } catch {
    return false; // someone else won the reclaim or the re-create -> stand aside
  }
}

export function releaseLock(lockPath: string = LOCK): void {
  try {
    if (!existsSync(lockPath)) return;
    const pid = Number(readFileSync(lockPath, 'utf8').trim().split(/\s+/)[0]); // tolerates the newer `pid\nts` format
    if (pid === process.pid) unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

// Orphan self-healing: once the lock is held, a session still stuck in a transient RUNNING state means the
// previous tick died midway -> reset it along a legal edge and re-run.
// Note: ADVERSARIAL_LOOP and GATE_B_REVISION_REQUESTED are already poller-driven states, and after an
// interrupted tick the normal poller picks them up and continues in place (the draft, round counter and
// sessions are persisted every round, so at most one round is lost). They must not be reclaimed here -
// otherwise every ordinary "paused at the per-tick cap" would be misreported as a recovery.
const RECLAIM: { from: State; fail: State; back: State }[] = [
  { from: 'GATE_B_RUNNING', fail: 'GATE_B_FAILED', back: 'GATE_B_REQUESTED' }, // the first draft died midway, so there is no draft -> a clean re-run
];

// Reset one orphan: increment reclaim_count; at the cap, or already dead-lettered, judge it a poison pill and
// move it to the dead-letter queue (no more revivals - alert and hand it to a human); otherwise reset and re-run
// normally.
async function reclaimOne(s: Session, from: State, fail: State, back: State): Promise<void> {
  const rc = (s.reclaim_count ?? 0) + 1;
  if (s.dead_letter || rc > maxReclaims()) {
    // A poison pill: running the gate repeatedly keeps dying midway (a deterministic crash that takes the
    // daemon with it) -> park it in the dead-letter queue, cutting the crash-restart-burn-tokens loop.
    await sessions.transition(s.id, fail, { error: `still dying midway after ${rc - 1} orphan resets; presumed a poison pill -> moved to the dead-letter queue for a human`, dead_letter: 1, next_retry_at: null });
    await sessions.appendEvent(s.id, 'dead_letter', { from, reason: 'max_reclaims', reclaim_count: rc - 1 });
    log.err(`${s.slug}: the orphaned ${from} state hit the reset cap (${maxReclaims()}) -> dead letter (presumed a poison pill), parked until a human retries`);
    await notify('failed', (await sessions.get(s.id))!, { stage: 'orphan reset', error: `still dying midway after ${rc - 1} resets; presumed a poison pill and moved to the dead-letter queue (a manual retry clears it)` });
    return;
  }
  await sessions.transition(s.id, fail, { error: 'orphaned RUNNING reclaimed (residue from an interrupted tick)', reclaim_count: rc });
  await sessions.transition(s.id, back, { error: null });
  await sessions.appendEvent(s.id, 'recover', { from, to: back, reclaim_count: rc });
  log.warn(`${s.slug}: orphaned ${from} -> ${back} (self-healing attempt ${rc}; it will re-run)`);
  await notify('recovered', (await sessions.get(s.id))!, { from, to: back });
}

async function reclaimOrphans(): Promise<void> {
  // An orphaned Gate A RUNNING state: a re-review that died midway (pending_input is still set) returns to the
  // re-review point without losing the rounds; otherwise a first-round orphan returns to INTAKE to re-run.
  for (const s of await sessions.listByStates(['GATE_A_RUNNING'])) {
    const back: State = s.gate_a_pending_input ? 'GATE_A_REVISION_REQUESTED' : 'INTAKE';
    await reclaimOne(s, 'GATE_A_RUNNING', 'GATE_A_FAILED', back);
  }
  // An orphaned Gate C worktree setup (GATE_C_RUNNING, a transient state that is not poller-driven): with a
  // worktree it continues into the implementation loop; without one it re-runs setup cleanly.
  // GATE_C_LOOP is poller-driven, and after an interrupted tick the normal poller continues it in place (the
  // envelope, round counter and session are persisted), so it is not reclaimed here.
  for (const s of await sessions.listByStates(['GATE_C_RUNNING'])) {
    const back: State = s.worktree_path ? 'GATE_C_LOOP' : 'GATE_C_REQUESTED';
    await reclaimOne(s, 'GATE_C_RUNNING', 'GATE_C_FAILED', back);
  }
  for (const { from, fail, back } of RECLAIM) {
    for (const s of await sessions.listByStates([from])) {
      await reclaimOne(s, from, fail, back);
    }
  }
}

const SWEEP_MIN_AGE_MS = 60 * 60 * 1000; // a one-hour age guard: never sweep a worktree that may still be being created (its worktree_path not yet persisted)

// Sweeping orphaned worktrees: it removes what a SHIPPED session left behind (when ackMerged's cleanup failed
// or never ran) plus forge-named orphans with no owner, and only once they are older than the guard window.
// Cleanup used to rest entirely on ackMerged's best-effort path, with comments assuming an "orphan sweep" that
// nobody had implemented - so under a long-running daemon the isolated worktrees (each carrying a full
// dependency tree) piled up without bound. The pure decision function planWorktreeSweep keeps it safe (anything
// in use, too new, or not forge-created is never touched).
// Best-effort: any failure only warns and must never interrupt a gate. The removal uses a plain
// `git worktree remove`, which needs no project script or package manager.
async function sweepOrphanWorktrees(): Promise<void> {
  try {
    // Multi-repo: a session's worktrees are spread across its legs (plus the older session-level worktree_path,
    // for compatibility). They are all gathered before being bucketed, so a live tree on a non-primary leg is
    // never left unprotected.
    const pathsOf = (s: Session): string[] => [s.worktree_path, ...getLegs(s).map((l) => l.worktree_path)].filter((p): p is string => !!p);
    const withWt = (await sessions.listAll()).filter((s) => pathsOf(s).length > 0);
    const shippedPaths = new Set(withWt.filter((s) => s.state === 'SHIPPED').flatMap(pathsOf));
    const livePaths = new Set(withWt.filter((s) => s.state !== 'SHIPPED').flatMap(pathsOf));
    // The set of repos to sweep: the repos of every project that has a session with a worktree, plus the default
    // project's (which covers orphans belonging to no session at all).
    const repoDirs = new Set<string>();
    const addRepo = (p: ReturnType<typeof project>): void => {
      for (const r of p.repos) repoDirs.add(p.repoPath(r)); // walk every repo: worktrees are anchored to their own target repo, so an orphan may sit under any of them, not only repos[0]
    };
    try {
      addRepo(project(defaultProjectId()));
    } catch {
      /* no default project configured -> skip */
    }
    for (const s of withWt) {
      try {
        addRepo(projectForSession(s));
      } catch {
        /* the project is missing -> skip */
      }
    }
    const now = Date.now();
    for (const repoDir of repoDirs) {
      const main = resolve(repoDir);
      const onDisk = listWorktrees(repoDir)
        .filter((p) => resolve(p) !== main) // never touch the main checkout
        .map((p) => {
          let ageMs = Number.POSITIVE_INFINITY; // the path is already gone (a stale registration) -> treat it as very old so the registration can be cleaned
          try {
            ageMs = now - statSync(p).mtimeMs;
          } catch {
            /* the directory is gone -> leave it at Infinity */
          }
          return { path: p, ageMs };
        });
      const toSweep = planWorktreeSweep({ onDisk, shippedPaths, livePaths, minAgeMs: SWEEP_MIN_AGE_MS });
      for (const path of toSweep) {
        const rm = await removeWorktree({ repoDir, path }); // a plain `git worktree remove --force` plus a prune
        const owner = withWt.find((s) => pathsOf(s).includes(path));
        // Delete the leftover forge/<...> branch: every leg's repo uses the same branch name (derived from the
        // id hash), so any branch name the owner knows will do.
        const branch = owner?.impl_branch ?? getLegs(owner ?? ({} as Session)).find((l) => l.impl_branch)?.impl_branch ?? null;
        if (branch) deleteBranch(repoDir, branch);
        log.warn(`Orphan sweep: removed the worktree ${path} (${rm.ok ? 'ok' : `failed: ${rm.output.slice(0, 80)}`})`);
      }
    }
  } catch (e) {
    log.warn(`The orphaned-worktree sweep threw this round (this does not affect the gates): ${String(e).slice(0, 140)}`);
  }
}

// A transient failure whose backoff has expired -> flip it automatically back into a runnable state (the same
// rule `forge retry` uses), and the ready scan below picks it up in the same tick.
// Dead-lettered sessions, ones whose backoff has not expired, and states with no retry path (WRITE_FAILED, for
// instance) are skipped. retry_count is not cleared - parkFailure moves it to the dead-letter queue once it is
// exhausted.
async function reconcileRetries(now: number): Promise<void> {
  // Every *_FAILED state with an automatic retry path is scanned: parkFailure schedules next_retry_at and
  // planRetry supports it, so missing one from the scan would mean "a retry was scheduled but never fires" - a
  // silent stall (Codex should-fix #1).
  for (const s of await sessions.listByStates(['GATE_A_FAILED', 'GATE_B_FAILED', 'GATE_C_FAILED', 'GATE_D_FAILED'])) {
    if (s.dead_letter) continue;
    if (s.next_retry_at == null || now < s.next_retry_at) continue;
    const plan = planRetry(s);
    if (!plan) continue;
    await sessions.transition(s.id, plan.to, { ...plan.fields, next_retry_at: null });
    await sessions.appendEvent(s.id, 'auto_retry', { from: s.state, to: plan.to, attempt: s.retry_count ?? 0 });
    log.warn(`${s.slug}: the backoff window has passed -> retrying automatically (attempt ${s.retry_count ?? 0} so far) ${s.state} -> ${plan.to}`);
  }
}

// Business-level reconciliation of parked sessions: one that has sat in a "waiting on a human" state for too
// long and has not been reminded recently gets its card re-sent, debounced.
// This closes the hole where a single failure or arbitration card sent while the IM was down would mean nobody
// ever finds out - the watchdog covers process liveness, and this covers business liveness.
const STUCK_AFTER_MS = hours(6); // parked and untouched for over 6h -> treat it as possibly forgotten
const REMIND_EVERY_MS = hours(12); // at most one reminder per session every 12h (the debounce)
// Which card each "waiting on a human" parked state re-sends (the same card as the first notification,
// including its buttons and CLI hints).
const STUCK_KIND: Partial<Record<State, NotifyKind>> = {
  GATE_A_FAILED: 'failed',
  GATE_B_FAILED: 'failed',
  WRITE_FAILED: 'failed',
  GATE_A_STALLED: 'needs_arbitration',
  GATE_B_STALLED: 'needs_gateb_arbitration',
  AWAITING_GATE_B_INPUT: 'needs_gateb_input',
  AWAITING_GO: 'needs_go',
  CONFIRMED: 'needs_gateb',
};

export async function remindStuck(now: number): Promise<void> {
  const states = Object.keys(STUCK_KIND) as State[];
  for (const s of await sessions.listByStates(states)) {
    if (now - s.updated_at < STUCK_AFTER_MS) continue;
    // A *_FAILED state with an automatic retry already scheduled (not dead-lettered, and next_retry_at is set)
    // is not waiting on a human, so it is not reminded.
    if (s.state.endsWith('FAILED') && !s.dead_letter && s.next_retry_at != null) continue;
    const last = await sessions.lastEventTs(s.id, 'stuck_reminded');
    if (last != null && now - last < REMIND_EVERY_MS) continue;
    const kind = STUCK_KIND[s.state];
    if (!kind) continue;
    await sessions.appendEvent(s.id, 'stuck_reminded', { state: s.state, idle_h: Math.round((now - s.updated_at) / 3600000), dead_letter: s.dead_letter ?? 0 });
    log.warn(`${s.slug}: parked at ${s.state} and untouched for ${Math.round((now - s.updated_at) / 3600000)}h -> re-sending the reminder`);
    await notify(kind, (await sessions.get(s.id))!, { stage: 'parked reminder', error: s.error ?? undefined });
  }
}

// Dispatch an autonomy action to its matching action (never with --force: if lint, assignment or a
// deterministic gate does not pass, the action itself returns !ok and the session honestly stays parked).
function runAutoAction(idOrSlug: string, action: AutoAction, by: string): Promise<ActionResult> {
  switch (action) {
    case 'requestGateB':
      return requestGateB(idOrSlug, by);
    case 'go':
      return go(idOrSlug, by);
    case 'requestGateC':
      return Promise.resolve(requestGateC(idOrSlug, by));
    case 'requestReviewPr':
      return Promise.resolve(requestReviewPr(idOrSlug, by));
  }
}

// Progressive autonomy: a session parked at a purely-authorisation resting point (CONFIRMED / AWAITING_GO /
// DONE / AWAITING_GATE_D) has its matching action triggered automatically, if its **project's** autonomy level
// allows it (acting as the configured actor, and recording an audit event). The default level is 0, so
// everything is skipped and behaviour is unchanged. The permission and deterministic gates inside each action
// (go's lint and assignment checks, never-merge, the CI-green precondition) remain the last line of defence -
// if one does not pass the action returns !ok and it is left to a human. It never automatically triggers a
// *_STALLED or *_INPUT state, and never a merge.
export async function applyAutonomy(): Promise<void> {
  for (const s of await sessions.listByStates([...AUTONOMY_GATES])) {
    // The whole flow for one session (including resolving its project) is wrapped in a try: if resolving or
    // acting on one throws, that one is recorded and the pass continues with the next - it must never abort the
    // whole pass (Codex SF).
    try {
      const { level, actor } = projectForSession(s).autonomy;
      if (level <= 0 || !actor) continue;
      const action = autoActionFor(s.state, level);
      if (!action) continue;
      // Debounce: one attempt per parked state - if the session has not changed since the last attempt
      // (updated_at <= the last attempt's ts; appendEvent does not bump updated_at) it is skipped, so a session
      // left parked by an !ok (a permission, lint or assignment check not passing) does not retry and spam
      // events every tick. It retries only once a human has changed the session (a patch or transition bumps
      // updated_at) (Codex SF).
      const lastTry = await sessions.lastEventTs(s.id, 'autonomy_auto_triggered');
      if (lastTry != null && s.updated_at <= lastTry) continue;
      // The audit record comes **before** the side effect: an auto-GO's go() may already have created the epic
      // and child issues and published the design before failing at the label or approve step (-> WRITE_FAILED)
      // and returning !ok. A real outward write like that must never happen without a trace - so "attempted" is
      // recorded first, then the action runs, and the result is appended afterwards (a Codex blocker).
      await sessions.appendEvent(s.id, 'autonomy_auto_triggered', { level, action, from: s.state, by: actor });
      const r = await runAutoAction(s.id, action, actor);
      const to = (await sessions.get(s.id))?.state ?? s.state;
      await sessions.appendEvent(s.id, 'autonomy_auto_result', { action, ok: r.ok, to, msg: r.ok ? undefined : r.msg.slice(0, 160) });
      if (r.ok) log.ok(`${s.slug}: autonomy L${level} automatically ran ${action} (${s.state} -> ${to}, as ${actor})`);
      else log.info(`${s.slug}: autonomy L${level} ${action} did not pass -> left to a human (${r.msg.slice(0, 120)})`);
    } catch (e) {
      await sessions.appendEvent(s.id, 'autonomy_auto_result', { ok: false, error: String(e).slice(0, 160) });
      log.warn(`${s.slug}: the autonomy trigger threw (this does not affect other sessions): ${String(e).slice(0, 140)}`);
    }
  }
}

// Run one round: pick up every ready session and advance them up to the concurrency cap. It holds the tick
// lock, and first self-heals orphaned states, picks up transient failures whose backoff has expired, and
// reminds about long-parked sessions.
export async function tick(): Promise<number> {
  if (!acquireLock()) {
    log.info('tick: another tick is already running, so this one is skipped');
    return 0;
  }
  // The extension hooks (onTickStart / onTickEnd) fire only on **the round that actually took the lock**, never
  // on a skipped one - otherwise anything downstream reconciling against tick events would count "squeezed out
  // by another tick" as an idle round.
  let processed = 0;
  let ok = false;
  try {
    await fireTickStart({ at: Date.now() });
    const cfg = loadConfig();
    const now = Date.now();
    // -- The control-plane orchestration policies (reclaim / retry / autonomy / remind / sweep / drift) run
    //    **only on the control plane, or in all-in-one mode** --
    // A pure runner (one with FORGE_CONTROL_URL set) **skips** them: otherwise several runners would each tick
    // and run these control-plane writes concurrently (orphan resets, backoff retries, autonomy triggers,
    // parked reminders, worktree sweeps, drift reconciliation), while the lease only protects the job loop and
    // reaches none of them - so with several runners they would fire repeatedly (duplicate retries, duplicate
    // autonomy-created issues, sweeps fighting each other). These are the control plane's job: in a split
    // deployment the control-plane process runs them and a runner only runs jobs.
    // By default (FORGE_CONTROL_URL unset) this is all-in-one, everything runs, and **behaviour is unchanged**.
    const pureRunner = !!process.env.FORGE_CONTROL_URL;
    if (!pureRunner) {
      await reclaimOrphans();
      await reconcileRetries(now);
      // Progressive autonomy runs before remindStuck: the authorisation points autonomy covers (CONFIRMED,
      // AWAITING_GO and so on) are meant to advance automatically, so it must not nag a human to "please handle
      // this" and then advance on its own in the same tick (a Codex nit).
      // The poller states it moves sessions into are picked up by claimDueJobs below in this same tick; at the
      // default level 0 everything is skipped and behaviour is unchanged.
      await applyAutonomy();
      await remindStuck(now);
      await sweepOrphanWorktrees(); // sweep orphaned worktrees (best-effort, with its own try/catch; it never interrupts a gate)
      // The post-kickoff drift loop (opt-in, off by default): once a DONE requirement's issues are all merged,
      // it reconciles the implementation against the acceptance contract and direct-messages the owner about any
      // drift.
      // It is a separate subsystem wrapped in a try/catch - no exception from it may ever interrupt the core
      // gates.
      if (cfg.runtime.drift?.enabled) {
        try {
          await reconcileDrift(now);
        } catch (e) {
          log.warn(`The drift loop threw this round (this does not affect the gates): ${String(e).slice(0, 160)}`);
        }
      }
    }
    // -- The runner job loop: **atomically claim** at most max_parallel due jobs through the JobSource seam (the
    //    lease stops several runners claiming the same one) -> run step for each.
    // The claim size is this round's concurrency capacity: only what will actually start running this round, and
    // never the whole backlog at once (see store leaseClaim: that would have queued jobs count down their TTL
    // and be re-claimed, so the same job runs twice).
    const ready = await jobSource.claimDueJobs(cfg.runtime.max_parallel);
    if (ready.length === 0) {
      log.info('tick: no sessions to process');
      ok = true;
      return 0;
    }
    log.info(`tick: ${ready.length} session(s) to process (concurrency cap ${cfg.runtime.max_parallel})`);
    await runLimited(ready, cfg.runtime.max_parallel, step);
    processed = ready.length;
    ok = true;
    return processed;
  } finally {
    releaseLock(); // release the lock before firing the hooks: a hook can take up to HOOK_TIMEOUT_MS, and it must not keep the next tick waiting at the door
    await fireTickEnd({ at: Date.now(), processed, ok });
  }
}
