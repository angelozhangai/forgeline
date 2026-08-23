import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectForSession, configForSession } from './projects.ts';
import { loadConfig, inAllowList } from './config.ts';
import { store as sessions } from './store/index.ts'; // through the SessionStore seam (the selection point), never straight to store/sessions.ts
import { doWrites } from './writes.ts';
import { prMergeState } from './workspace.ts';
import { commentDoc } from './docs/index.ts';
import { notify, syncGroupCard } from './notify.ts';
import { normSize, SIZES, sizeBadge } from './util/sizing.ts';
import { probeLoad } from './util/load.ts';
import { recommend, inPool, type Recommendation } from './util/assign.ts';
import { removeWorktree, deleteBranch } from './util/worktree.ts';
import { reqRef, answerRoundTag } from './util/display.ts';
import { log } from './util/log.ts';
import { lintAcceptance } from './util/acceptance.ts';
import { GateBSchema, humanAsksToDecisions, composeDecisionAnswer } from './gates/envelopes.ts';
import { resolveTargetRepos, primaryTargetRepo } from './util/targetRepos.ts';
import { getLegs, patchLeg } from './gates/legs.ts';
import { readGateAEnvelope } from './gates/gateALoop.ts';
import { writePrdTruth } from './gates/prdTruth.ts';
import { planRetry } from './orchestrator/retry.ts';
import type { GateBEnvelope, HumanAsk } from './gates/envelopes.ts';
import type { Session } from './types.ts';
import type { Config } from './config.ts';
import type { State } from './statemachine/states.ts';

// The retry bookkeeping both a manual and an automatic retry reset (a manual retry counts as a forced
// override: it clears the dead letter and resets the retry and reclaim counters to zero).
const RETRY_BOOKKEEPING_RESET: Partial<Session> = {
  retry_count: null,
  next_retry_at: null,
  reclaim_count: null,
  dead_letter: null,
  // A manual retry is a manual reset of the circuit breaker: it clears each gate's consecutive fix-failure
  // count, giving "I fixed the underlying problem, now retry" a fresh budget (otherwise the streak left over
  // from last time is already at its cap, and one failure would immediately STALL it again).
  gate_a_fix_fail_streak: null,
  gate_b_fix_fail_streak: null,
  gate_c_fix_fail_streak: null,
  gate_d_fix_fail_streak: null,
};

// Compose the escalation answer form's selections and free-text notes into one structured answer (fed back
// into the same claude session to carry on).
// fv looks like { ask_H1: '<one of the options>' | '__other__', ask_H2: '...', notes: '...' }.
// The ids are purely positional (askId(i) = H{n}) and come from the same asks array notify rendered, in the
// same order, which is what guarantees an option lines up with its question — the LLM's own ids are not
// trusted.
export function composeHumanAnswer(asks: HumanAsk[], fv: Record<string, string>): string {
  return composeDecisionAnswer(humanAsksToDecisions(asks), fv);
}

export interface ActionResult {
  ok: boolean;
  msg: string;
}

export function markReviewActive(deliveryDir: string, slug: string): void {
  const doc = resolve(deliveryDir, slug, 'req-review.md');
  if (!existsSync(doc)) return;
  const t = readFileSync(doc, 'utf8').replace(
    /^status: draft.*$/m,
    'status: active           # decided (Gate A passed, confirmed by the service)',
  );
  writeFileSync(doc, t);
}

// A reviewer sets or adjusts the complexity tier (the human confirmation after the AI's proposal; the tier
// travels the whole way through, is written into the issue, and can be summed into a workload).
export async function setSize(idOrSlug: string, sizeRaw: string, by: string, reason?: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  if (!s) return { ok: false, msg: `no such session: ${idOrSlug}` };
  const size = normSize(sizeRaw);
  if (!size) return { ok: false, msg: `${sizeRaw} is not a valid tier; use one of ${SIZES.join('/')}` };
  await sessions.patch(s.id, { size, size_source: 'human', ...(reason ? { size_reason: reason } : {}) });
  await sessions.appendEvent(s.id, 'size_set', { size, by, reason: reason ?? null });
  void syncGroupCard((await sessions.get(s.id))!).catch(() => undefined); // refresh the complexity shown on the channel card
  return { ok: true, msg: `✓ ${reqRef(s)} complexity -> ${sizeBadge(size)} (confirmed by ${by})` };
}

// Probe the candidate pool's load and compute the automatic assignment recommendation (async IO: one gh call
// per person per repo). The size comes from the tier set on the session.
async function computeReco(s: Session): Promise<Recommendation> {
  const cfg = configForSession(s); // configuration diverges per project: the candidate pool and the load formula follow this session's project (its assignment override)
  const proj = projectForSession(s); // the org, the repos scanned and the umbrella all follow this session's project (your-monorepo may be a different org with its own repos)
  const loads = await probeLoad(cfg, proj); // the structural subset of proj that probeLoad needs: owner/repos/umbrella/repoSlugs/repoMap (which carries the cross-repo letters)

  return recommend(normSize(s.size ?? ''), loads, cfg.assignment);
}

// The table explaining the recommendation (shown by the CLI, and as the card's fallback): one line each with
// work in progress against the limit, the load and the projection, marking the recommended person and anyone
// over their WIP limit.
export function formatRecoTable(reco: Recommendation): string {
  return reco.table
    .map((r) => {
      const mark = r.code === reco.pick ? '→' : ' ';
      if (r.ok === false) return `  ${mark} ${r.code.padEnd(3)} load unknown (the probe failed, so they are excluded)`;
      const cap = r.eligible ? '' : ' ✗ over WIP';
      return `  ${mark} ${r.code.padEnd(3)} in progress ${r.wip}/${r.wipLimit} · load ${r.loadPoints.toFixed(1)} -> projected ${r.projected.toFixed(1)}${cap}`;
    })
    .join('\n');
}

// Compute the automatic recommendation on entering AWAITING_GO and persist it (best-effort, and it never
// throws — failing to compute an assignment must not block the work being opened).
// Persist the recommendation. With a pick -> adopt it (source='auto'). With no pick (every probe failed, or
// the pool is empty) -> force a human decision: clear the *previous* auto assignment so a stale DRI cannot
// slip through the GO gate, while keeping a human assignment (source='human' — the maintainer's explicit
// decision is not wiped out by a failed probe).
// It returns whether a stale auto assignment was cleared (for the caller to report and audit).
async function persistReco(s: Session, reco: Recommendation, by: string): Promise<boolean> {
  if (reco.pick) {
    await sessions.patch(s.id, {
      assign_snapshot: JSON.stringify(reco),
      assignee: reco.pick,
      assignee_source: 'auto',
      assigned_by: by,
      assigned_at: Date.now(),
    });
    return false;
  }
  const clearStale = s.assignee_source === 'auto';
  await sessions.patch(s.id, {
    assign_snapshot: JSON.stringify(reco),
    ...(clearStale ? { assignee: null, assignee_source: null, assigned_by: null, assigned_at: null } : {}),
  });
  return clearStale;
}

// The recommended person is adopted by default (source='auto'); the maintainer can reassign from the GO card
// or the CLI. A failed probe clears the stale auto assignment and leaves assignee empty, and the GO card
// degrades to picking someone by hand.
export async function autoAssignOnGo(idOrSlug: string): Promise<void> {
  try {
    const s = await sessions.resolve(idOrSlug);
    if (!s) return;
    const reco = await computeReco(s);
    const cleared = await persistReco(s, reco, 'auto');
    await sessions.appendEvent(s.id, 'assign_auto', { pick: reco.pick, allOverWip: reco.allOverWip, probeIncomplete: reco.probeIncomplete, clearedStaleAuto: cleared });
  } catch (e) {
    log.warn(`computing the automatic assignment failed (it does not affect opening the work): ${String(e).slice(0, 140)}`);
  }
}

// Assign the DRI: either named by hand (--to) or by recomputing the automatic recommendation. The permission
// is the same as GO's (go_approvers — it is a management decision).
export async function assign(
  idOrSlug: string,
  by: string,
  opts: { to?: string; auto?: boolean } = {},
): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // configuration diverges per project: permissions, routing and assignment resolve against the session's project (when s is null the next line returns)
  if (!s) return { ok: false, msg: `no such session: ${idOrSlug}` };
  if (!inAllowList(cfg, cfg.permissions.go_approvers, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'assign', by });
    return { ok: false, msg: `✗ ${by} may not assign (go_approvers=${cfg.permissions.go_approvers.join(',')})` };
  }
  // Named by hand
  if (opts.to) {
    const code = inPool(cfg.assignment, opts.to);
    if (!code) return { ok: false, msg: `${opts.to} is not a valid assignee; use one of ${cfg.assignment.pool.join('/')}` };
    await sessions.patch(s.id, { assignee: code, assignee_source: 'human', assigned_by: by, assigned_at: Date.now() });
    await sessions.appendEvent(s.id, 'assign', { to: code, by, source: 'human' });
    void syncGroupCard((await sessions.get(s.id))!).catch(() => undefined);
    return { ok: true, msg: `✓ ${reqRef(s)} assigned to ${code} (by hand, by ${by})` };
  }
  // Automatic: probe the load and recommend
  const reco = await computeReco(s);
  const cleared = await persistReco(s, reco, by);
  await sessions.appendEvent(s.id, 'assign_auto', { pick: reco.pick, allOverWip: reco.allOverWip, probeIncomplete: reco.probeIncomplete, by, clearedStaleAuto: cleared });
  void syncGroupCard((await sessions.get(s.id))!).catch(() => undefined);
  if (!reco.pick) {
    const note = cleared ? ' (the previous automatic assignment has been cleared)' : '';
    return { ok: false, msg: `no recommendation could be computed (every load probe in the candidate pool failed, or the pool is empty)${note}. Assign by hand: ./forge assign ${s.slug} <${cfg.assignment.pool.join('|')}> --user ${by}\n${formatRecoTable(reco)}` };
  }
  const warn =
    (reco.allOverWip ? ' (⚠ everyone known is at their WIP limit, so it fell back to the best of them)' : '') +
    (reco.probeIncomplete ? ' (⚠ some load probes failed, so those people are excluded)' : '');
  return { ok: true, msg: `✓ ${reqRef(s)} automatically assigned to ${reco.pick}${warn}\n${formatRecoTable(reco)}` };
}

// The text of the confirmation comment (a pure function, easy to unit-test): product's selection and notes
// from the channel card, or the lead forcing it through, written as the next comment on the PRD document.
export function confirmCommentText(round: number, opts: { who: string; verdict?: string; notes?: string }): string {
  const pick =
    opts.verdict === 'partial' ? 'partially accepted (see the notes)'
      : opts.verdict === 'force' ? 'forced through · the review is closed'
        : opts.verdict === 'accept' ? 'suggestions accepted, confirmed'
          : null;
  const head = opts.verdict === 'force' ? `[Engineering lead confirmed · round ${round}]` : `[Product confirmed · round ${round}]`;
  const lines = [head, `Confirmed by: ${opts.who}`];
  if (pick) lines.push(`Choice: ${pick}`);
  lines.push(`Notes: ${(opts.notes ?? '').trim() || '(none)'}`);
  return lines.join('\n');
}

// Post the confirmation comment on the PRD document (a top-level comment, landing after the question
// comments; best-effort, and it never blocks the pipeline).
export function postConfirmComment(s: Session, opts: { who: string; verdict?: string; notes?: string }): void {
  if (!s.doc_ref) return;
  void commentDoc(s.doc_ref, confirmCommentText(s.gate_a_round ?? 1, opts));
}

// Product submitting answers from the channel card: this does not settle anything, it feeds them back into
// the same claude session for another round of review (Gate A's multi-round loop).
// Product only *answers*; the power to end it belongs to claude (when no open question remains) or to the
// maintainer (forcing it closed — see confirm).
export async function submitPmAnswers(idOrSlug: string, by: string, answers?: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  if (!s) return { ok: false, msg: `no such session: ${idOrSlug}` };
  if (s.state === 'GATE_A_REVISION_REQUESTED') return { ok: true, msg: 'already submitted; the re-review is queued (idempotent)' };
  if (s.state !== 'AWAITING_PM_CONFIRM') {
    return { ok: false, msg: `the current state is ${s.state}, so answers cannot be submitted (AWAITING_PM_CONFIRM is required)` };
  }
  const round = s.gate_a_round ?? 1;
  const ans = (answers ?? '').trim();
  // Accumulate each round's answers from product, keeping a human-readable record of the decisions
  // (confirmed_notes).
  const history = s.confirmed_notes ? `${s.confirmed_notes}\n` : '';
  const merged = `${history}${answerRoundTag(round)} ${ans || '(no notes)'}`;
  await sessions.transition(s.id, 'GATE_A_REVISION_REQUESTED', {
    gate_a_pending_input: ans,
    confirmed_notes: merged,
  });
  await sessions.appendEvent(s.id, 'pm_answer', { by, round, answers: ans || null });
  return { ok: true, msg: `✓ ${reqRef(s)} round ${round}'s answers received; moving to the re-review` };
}

// The maintainer forcing the review closed, or deciding it, to CONFIRMED (product does not have this
// permission). It can be called while waiting on product (AWAITING_PM_CONFIRM) or while parked for a
// decision (GATE_A_STALLED).
export async function confirm(idOrSlug: string, by: string, notes?: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // configuration diverges per project: permissions, routing and assignment resolve against the session's project (when s is null the next line returns)
  if (!s) return { ok: false, msg: `no such session: ${idOrSlug}` };
  // Forcing the review closed, or deciding it, is a management-level decision (like forceGateBGo): it
  // requires go_approvers. The card surface merely agrees that "product has no such button", but once #2
  // wired the real clicker through, an unfamiliar open_id reaches here too — the CLI and API layer has to
  // guard it as well, and must never wave someone through as if they were the maintainer.
  if (!inAllowList(cfg, cfg.permissions.go_approvers, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'confirm', by });
    return { ok: false, msg: `✗ ${by} may not confirm (go_approvers=${cfg.permissions.go_approvers.join(',')})` };
  }
  if (s.state === 'CONFIRMED') return { ok: true, msg: 'already confirmed (idempotent)' };
  if (s.state !== 'AWAITING_PM_CONFIRM' && s.state !== 'GATE_A_STALLED') {
    return { ok: false, msg: `the current state is ${s.state}, so it cannot be confirmed (AWAITING_PM_CONFIRM or GATE_A_STALLED is required)` };
  }
  markReviewActive(projectForSession(s).deliveryDir, s.slug);
  // Keep the history of product's answers across rounds (Gate B reads confirmed_notes): notes are appended,
  // never overwritten.
  const merged = notes ? (s.confirmed_notes ? `${s.confirmed_notes}\n${notes}` : notes) : (s.confirmed_notes ?? null);
  await sessions.transition(s.id, 'CONFIRMED', {
    confirmed_by: by,
    confirmed_at: Date.now(),
    confirmed_notes: merged,
  });
  await sessions.appendEvent(s.id, 'pm_confirm', { by, notes: notes ?? null });
  postConfirmComment(s, { who: by, verdict: 'force', notes }); // the lead forcing it through leaves a record on the document
  // Sealing it: the maintainer's forced confirmation also composes the PRD source of truth (it bypasses the
  // adversarial review, but Gate B still needs one single requirement input). Best-effort.
  try {
    writePrdTruth((await sessions.get(s.id))!);
  } catch (e) {
    log.warn(`${s.slug}: writing the sealed PRD source of truth to disk failed (Gate B rebuilds it as a fallback) - ${String(e).slice(0, 120)}`);
  }
  return {
    ok: true,
    msg: `✓ ${s.slug} -> CONFIRMED. Next: ./forge gateb ${s.slug} --user <someone with Gate B permission>`,
  };
}

// Trigger Gate B (only for someone on the permission list)
export async function requestGateB(idOrSlug: string, by: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // configuration diverges per project: permissions, routing and assignment resolve against the session's project (when s is null the next line returns)
  if (!s) return { ok: false, msg: `no such session: ${idOrSlug}` };
  if (s.state === 'GATE_B_REQUESTED') return { ok: true, msg: 'Gate B already requested (idempotent); waiting for the next tick' };
  if (s.state !== 'CONFIRMED') {
    return { ok: false, msg: `the current state is ${s.state}; it has to be CONFIRMED first` };
  }
  if (!inAllowList(cfg, cfg.permissions.gate_b_allowed, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'gateb', by });
    return { ok: false, msg: `✗ ${by} may not run Gate B (gate_b_allowed=${cfg.permissions.gate_b_allowed.join(',')})` };
  }
  await sessions.transition(s.id, 'GATE_B_REQUESTED', { gate_b_requested_by: by });
  return { ok: true, msg: `✓ Gate B requested (by ${by}). The next ./forge tick runs Gate B and the adversarial review automatically.` };
}

// Trigger Gate C (implementation plus local CI): chained, it starts from DONE (the issues exist). A bare
// standalone issue goes through intake.addImplementTask instead (which starts directly at
// GATE_C_REQUESTED).
// The permission is gate_c_allowed (falling back to go_approvers).
export async function requestGateC(idOrSlug: string, by: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // configuration diverges per project: permissions, routing and assignment resolve against the session's project (when s is null the next line returns)
  if (!s) return { ok: false, msg: `no such session: ${idOrSlug}` };
  if (s.state === 'GATE_C_REQUESTED') return { ok: true, msg: 'Gate C already requested (idempotent); waiting for the next tick' };
  if (s.state !== 'DONE') {
    return { ok: false, msg: `the current state is ${s.state}; it has to be DONE (the issues exist) before Gate C. To run a bare issue on its own, use ./forge implement --issue <ref>` };
  }
  const allow = cfg.permissions.gate_c_allowed ?? cfg.permissions.go_approvers;
  if (!inAllowList(cfg, allow, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'gatec', by });
    return { ok: false, msg: `✗ ${by} may not run Gate C (gate_c_allowed=${allow.join(',')})` };
  }
  // Chained: the target repos come from Gate A's repos_touched ∩ proj.repos (the implementation anchors to
  // the repo the requirement really changes, never hardcoded to repos[0] again).
  // A missing or malformed envelope falls back to proj.repos[0] (resolveTargetRepos handles it), and never
  // blocks the work.
  let touched: string[] = [];
  try {
    touched = readGateAEnvelope(s).repos_touched ?? [];
  } catch {
    touched = [];
  }
  const proj = projectForSession(s);
  const targetRepos = resolveTargetRepos(touched, proj.repos, proj.repoMap); // repoMap turns Gate A's letters C/U/A/E into repo names (never comparing a letter against a repo name, matching nothing, and falling back to the first repo)
  await sessions.transition(s.id, 'GATE_C_REQUESTED', {
    gate_c_requested_by: by,
    source_kind: s.source_kind ?? 'prd',
    target_repos: JSON.stringify(targetRepos),
  });
  return { ok: true, msg: `✓ Gate C requested (by ${by}) -> target repos ${targetRepos.join(', ') || '(the first repo)'}. The next ./forge tick creates the worktree, implements, and runs local CI automatically.` };
}

// The maintainer answering an escalated question from Gate C's implementation (needs_human), or deciding a
// parked session, feeding it back into the same claude session to carry on. The permission is
// gate_c_allowed (falling back to go_approvers).
export async function submitGateCAnswers(idOrSlug: string, by: string, answer?: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // configuration diverges per project: permissions, routing and assignment resolve against the session's project (when s is null the next line returns)
  if (!s) return { ok: false, msg: `no such session: ${idOrSlug}` };
  const allow = cfg.permissions.gate_c_allowed ?? cfg.permissions.go_approvers;
  if (!inAllowList(cfg, allow, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'gatec_answer', by });
    return { ok: false, msg: `✗ ${by} may not answer for Gate C (gate_c_allowed=${allow.join(',')})` };
  }
  if (s.state === 'GATE_C_REVISION_REQUESTED') return { ok: true, msg: 'already submitted; carrying on is queued (idempotent)' };
  if (s.state !== 'AWAITING_GATE_C_INPUT' && s.state !== 'GATE_C_STALLED') {
    return { ok: false, msg: `the current state is ${s.state}, so it cannot be answered (AWAITING_GATE_C_INPUT or GATE_C_STALLED is required)` };
  }
  const round = s.gate_c_round ?? 1;
  const ans = (answer ?? '').trim();
  await sessions.transition(s.id, 'GATE_C_REVISION_REQUESTED', {
    gate_c_pending_input: ans || '(the maintainer gave no specific decision; treated as one more round)',
  });
  await sessions.appendEvent(s.id, 'gatec_answer', { by, round, answer: ans || null, from: s.state });
  return { ok: true, msg: `✓ ${reqRef(s)} decision received; carrying on (after round ${round})` };
}

// Trigger Gate D (open the PR and cross-review it): once Gate C is green it starts from AWAITING_GATE_D. The
// permission is pr_create_approvers (falling back to go_approvers).
// This only sets GATE_D_REQUESTED — actually opening the PR (delegated to forge-create-pr.sh, and never an
// automatic merge) is the worker's job on the next tick.
export async function requestReviewPr(idOrSlug: string, by: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // configuration diverges per project: permissions, routing and assignment resolve against the session's project (when s is null the next line returns)
  if (!s) return { ok: false, msg: `no such session: ${idOrSlug}` };
  if (s.state === 'GATE_D_REQUESTED') return { ok: true, msg: 'Gate D already requested (idempotent); the PR opens on the next tick' };
  if (s.state !== 'AWAITING_GATE_D') {
    return { ok: false, msg: `the current state is ${s.state}; Gate C has to be green (AWAITING_GATE_D) before a PR can be opened for Gate D` };
  }
  const allow = cfg.permissions.pr_create_approvers ?? cfg.permissions.go_approvers;
  if (!inAllowList(cfg, allow, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'review_pr', by });
    return { ok: false, msg: `✗ ${by} may not open a PR (pr_create_approvers=${allow.join(',')})` };
  }
  await sessions.transition(s.id, 'GATE_D_REQUESTED', { gate_d_requested_by: by });
  return { ok: true, msg: `✓ Gate D requested (by ${by}). The next ./forge tick delegates opening the PR (never merging it automatically), then codex reviews the diff and claude fixes.` };
}

// The maintainer answering an escalated question from Gate D's PR review (needs_human), or deciding a parked
// session, feeding it back into the same claude session to carry on. The permission is pr_create_approvers
// (falling back to go_approvers).
export async function submitGateDAnswers(idOrSlug: string, by: string, answer?: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // configuration diverges per project: permissions, routing and assignment resolve against the session's project (when s is null the next line returns)
  if (!s) return { ok: false, msg: `no such session: ${idOrSlug}` };
  const allow = cfg.permissions.pr_create_approvers ?? cfg.permissions.go_approvers;
  if (!inAllowList(cfg, allow, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'gated_answer', by });
    return { ok: false, msg: `✗ ${by} may not answer for Gate D (pr_create_approvers=${allow.join(',')})` };
  }
  if (s.state === 'GATE_D_REVISION_REQUESTED') return { ok: true, msg: 'already submitted; the revision is queued (idempotent)' };
  if (s.state !== 'AWAITING_GATE_D_INPUT' && s.state !== 'GATE_D_STALLED') {
    return { ok: false, msg: `the current state is ${s.state}, so it cannot be answered (AWAITING_GATE_D_INPUT or GATE_D_STALLED is required)` };
  }
  const round = s.gate_d_round ?? 1;
  const ans = (answer ?? '').trim();
  await sessions.transition(s.id, 'GATE_D_REVISION_REQUESTED', {
    gate_d_pending_input: ans || '(the maintainer gave no specific decision; treated as one more round)',
  });
  await sessions.appendEvent(s.id, 'gated_answer', { by, round, answer: ans || null, from: s.state });
  return { ok: true, msg: `✓ ${reqRef(s)} decision received; carrying on with the revision (after round ${round})` };
}

// The verification decision taken before acknowledging a merge (a pure function, for unit tests). `verify` is
// the gh query on the PR's merge state; `force` is a human overriding it.
// Verified merged -> proceed (irreversible cleanup plus SHIPPED); not merged, or unknown -> refuse (an
// answer that cannot be obtained is never treated as merged). `force` overrides it, but leaves an audit
// trail.
export function mergeAckDecision(
  verify: { ok: boolean; merged: boolean; state: string; error?: string },
  force: boolean,
): { proceed: boolean; forced: boolean; reason: string } {
  if (verify.ok && verify.merged) return { proceed: true, forced: false, reason: `verified merged (${verify.state})` };
  if (force) {
    return { proceed: true, forced: true, reason: verify.ok ? `the PR is not merged (${verify.state}), overridden with --force` : `the merge state could not be read (${verify.error ?? 'gh failed'}), overridden with --force` };
  }
  return {
    proceed: false,
    forced: false,
    reason: verify.ok
      ? `the PR is not merged yet (currently ${verify.state}) — forge does not merge for you, so merge it on GitHub first; if it really is merged, add --force`
      : `the PR's merge state could not be verified (${verify.error ?? 'gh failed'}) — refusing conservatively (an answer that cannot be obtained is never treated as merged); if it really is merged, add --force`,
  };
}

// Acknowledging a human-merged PR, moving to SHIPPED (clearing the isolated worktree and handing off to the
// drift loop). The permission is merge_ack_allowed (falling back to go_approvers).
// This is a human **confirming** that it was merged — forge never merges automatically (red line #2), it
// only wraps up and cleans up afterwards.
// Before the irreversible cleanup it **verifies with gh that the PR really was merged** (the red line: an
// answer that cannot be obtained is never treated as merged); not merged or unknown -> refuse, which
// --force can override.
export async function ackMerged(idOrSlug: string, by: string, opts: { force?: boolean } = {}): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // configuration diverges per project: permissions, routing and assignment resolve against the session's project (when s is null the next line returns)
  if (!s) return { ok: false, msg: `no such session: ${idOrSlug}` };
  if (s.state === 'SHIPPED') return { ok: true, msg: 'the merge is already acknowledged (idempotent)' };
  if (s.state !== 'AWAITING_HUMAN_MERGE') {
    return { ok: false, msg: `the current state is ${s.state}, so a merge cannot be acknowledged (AWAITING_HUMAN_MERGE is required)` };
  }
  const allow = cfg.permissions.merge_ack_allowed ?? cfg.permissions.go_approvers;
  if (!inAllowList(cfg, allow, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'merged', by });
    return { ok: false, msg: `✗ ${by} may not acknowledge a merge (merge_ack_allowed=${allow.join(',')})` };
  }
  const driftNote = cfg.runtime.drift?.enabled ? "The drift loop will reconcile the merged implementation against Gate B's acceptance contract." : '';

  // Multi-repo (one tree and one PR per repo): verify each leg's own PR merge state — the irreversible
  // cleanup and SHIPPED only happen once **all** of them are merged (or --force). If any leg is unmerged or
  // unknown it refuses, and a requirement is never declared shipped while a leg is still unmerged (the
  // blocker Codex raised as 2c). With no legs (an older in-flight session) it takes the single-PR path
  // below.
  const legs = getLegs(s).filter((l) => l.worktree_path);
  if (legs.length) {
    const checks = [];
    for (const leg of legs) {
      const v = leg.pr_url ? await prMergeState(leg.pr_url) : { ok: false, merged: false, state: 'NO_PR_URL', error: `${leg.repo} has no pr_url` };
      checks.push({ leg, verify: v, decision: mergeAckDecision(v, !!opts.force) });
    }
    const blocked = checks.filter((c) => !c.decision.proceed);
    if (blocked.length) {
      await sessions.appendEvent(s.id, 'merge_ack_refused', { by, blocked: blocked.map((c) => ({ repo: c.leg.repo, state: c.verify.state })) });
      return {
        ok: false,
        msg: `✗ ${blocked.length}/${legs.length} repos have a PR that is unmerged or unknown: ${blocked.map((c) => `${c.leg.repo}(${c.verify.state})`).join(', ')} — forge does not merge for you, so merge them on GitHub first; if they really are merged, add --force`,
      };
    }
    const forced = checks.filter((c) => c.decision.forced);
    if (forced.length) await sessions.appendEvent(s.id, 'merge_ack_forced', { by, repos: forced.map((c) => c.leg.repo), states: forced.map((c) => c.verify.state) });
    // Clear **every** leg's isolated worktree and branch (each in its own repo; best-effort — a failed
    // cleanup never blocks SHIPPED, and anything left behind is caught by the orphan sweep).
    const proj = projectForSession(s);
    const removeScript = proj.scripts.worktree_remove ? resolve(proj.root, proj.scripts.worktree_remove) : undefined;
    for (const leg of legs) {
      try {
        const repoDir = proj.repoPath(leg.repo); // each worktree is anchored in its own repo, so cleanup locates it repo by repo (never hardcoded to repos[0])
        if (leg.worktree_path) {
          const rm = await removeWorktree({ repoDir, path: leg.worktree_path, removeScript });
          if (leg.impl_branch) deleteBranch(repoDir, leg.impl_branch);
          await sessions.appendEvent(s.id, 'worktree_cleaned', { repo: leg.repo, path: leg.worktree_path, ok: rm.ok, output: rm.output.slice(0, 160) });
        }
        await patchLeg(s, leg.repo, { merged: true });
      } catch (e) {
        log.warn(`${s.slug}: cleaning up ${leg.repo}'s worktree after the merge failed (it does not block SHIPPED) - ${String(e).slice(0, 140)}`);
      }
    }
    await sessions.transition(s.id, 'SHIPPED', { merged_by: by, merged_at: Date.now() });
    await sessions.appendEvent(s.id, 'merged', { by, prs: legs.map((l) => l.pr_url) });
    return { ok: true, msg: `✓ ${reqRef(s)} -> SHIPPED (${by} acknowledged the merge of ${legs.length} repos' PRs). ${driftNote}` };
  }

  // Verify the PR really was merged before the irreversible cleanup (deleting the worktree and the branch)
  // and SHIPPED. No pr_url counts as unknown.
  const verify = s.pr_url ? await prMergeState(s.pr_url) : { ok: false, merged: false, state: 'NO_PR_URL', error: 'no pr_url' };
  const decision = mergeAckDecision(verify, !!opts.force);
  if (!decision.proceed) {
    await sessions.appendEvent(s.id, 'merge_ack_refused', { by, state: verify.state, reason: decision.reason });
    return { ok: false, msg: `✗ ${decision.reason}` };
  }
  if (decision.forced) await sessions.appendEvent(s.id, 'merge_ack_forced', { by, state: verify.state, reason: decision.reason });
  // Clear the isolated worktree and the implementation branch (best-effort — a failed cleanup never blocks
  // SHIPPED, and anything left behind is caught by the orphan sweep).
  try {
    const proj = projectForSession(s);
    const repo = primaryTargetRepo(s, proj.repos); // the worktree is anchored in this session's target repo, and cleanup has to locate that same repo (never hardcoded to repos[0])
    const repoDir = proj.repoPath(repo);
    const removeScript = proj.scripts.worktree_remove ? resolve(proj.root, proj.scripts.worktree_remove) : undefined;
    if (s.worktree_path) {
      const rm = await removeWorktree({ repoDir, path: s.worktree_path, removeScript });
      if (s.impl_branch) deleteBranch(repoDir, s.impl_branch);
      await sessions.appendEvent(s.id, 'worktree_cleaned', { path: s.worktree_path, ok: rm.ok, output: rm.output.slice(0, 160) });
    }
  } catch (e) {
    log.warn(`${s.slug}: cleaning up the worktree after the merge failed (it does not block SHIPPED) - ${String(e).slice(0, 140)}`);
  }
  await sessions.transition(s.id, 'SHIPPED', { merged_by: by, merged_at: Date.now() });
  await sessions.appendEvent(s.id, 'merged', { by, pr_url: s.pr_url ?? null });
  return { ok: true, msg: `✓ ${reqRef(s)} -> SHIPPED (${by} acknowledged the merge). ${driftNote}` };
}

// The maintainer answering an escalated question from Gate B's revision (needs_human), feeding it back into
// the same claude session to carry on (Gate B's multi-round human-in-the-loop).
// It can be called while waiting for an answer (AWAITING_GATE_B_INPUT) or while parked for a decision
// (GATE_B_STALLED, where the maintainer chose "one more round").
// This is an **architecture, product or risk** level decision (not a product answer), so it requires
// gate_b_allowed — the card surface hardcoding the maintainer is only a convention, and the CLI and API
// layer has to guard it too.
export async function submitGateBAnswers(idOrSlug: string, by: string, answer?: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // configuration diverges per project: permissions, routing and assignment resolve against the session's project (when s is null the next line returns)
  if (!s) return { ok: false, msg: `no such session: ${idOrSlug}` };
  if (!inAllowList(cfg, cfg.permissions.gate_b_allowed, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'gateb_answer', by });
    return { ok: false, msg: `✗ ${by} may not answer for Gate B (gate_b_allowed=${cfg.permissions.gate_b_allowed.join(',')})` };
  }
  if (s.state === 'GATE_B_REVISION_REQUESTED') return { ok: true, msg: 'already submitted; the revision is queued (idempotent)' };
  if (s.state !== 'AWAITING_GATE_B_INPUT' && s.state !== 'GATE_B_STALLED') {
    return { ok: false, msg: `the current state is ${s.state}, so it cannot be answered (AWAITING_GATE_B_INPUT or GATE_B_STALLED is required)` };
  }
  const round = s.gate_b_round ?? 1;
  const ans = (answer ?? '').trim();
  // Note: adversarial_residual is **not** cleared here. If the revision or the parsing then fails into
  // GATE_B_FAILED, the old unresolved comments are still audit evidence, and must be kept until one
  // successful revision review produces a new conclusion (they are cleared on resolution in
  // worker.afterGateB — see there).
  await sessions.transition(s.id, 'GATE_B_REVISION_REQUESTED', {
    gate_b_pending_input: ans || '(the maintainer gave no specific decision; treated as one more round)',
  });
  await sessions.appendEvent(s.id, 'gateb_answer', { by, round, answer: ans || null, from: s.state });
  return { ok: true, msg: `✓ ${reqRef(s)} decision received; carrying on with the revision (after round ${round})` };
}

// The maintainer forcing the work open from the "the plan is waiting on a decision" parked state, moving to
// AWAITING_GO (keeping the outstanding comments for the GO card to show). It requires go_approvers, like
// confirm.
export async function forceGateBGo(idOrSlug: string, by: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // configuration diverges per project: permissions, routing and assignment resolve against the session's project (when s is null the next line returns)
  if (!s) return { ok: false, msg: `no such session: ${idOrSlug}` };
  if (s.state === 'AWAITING_GO') return { ok: true, msg: 'already released and waiting on GO (idempotent)' };
  if (s.state !== 'GATE_B_STALLED') {
    return { ok: false, msg: `the current state is ${s.state}, so the work cannot be forced open (GATE_B_STALLED is required)` };
  }
  if (!inAllowList(cfg, cfg.permissions.go_approvers, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'gateb_force_go', by });
    return { ok: false, msg: `✗ ${by} may not GO (go_approvers=${cfg.permissions.go_approvers.join(',')})` };
  }
  // adversarial_residual is kept: the GO card still shows "N awaiting a decision", which is what makes the
  // "a human must decide before release" contract real (outstanding comments are never dropped silently).
  await sessions.transition(s.id, 'AWAITING_GO');
  await sessions.appendEvent(s.id, 'gateb_force_go', { by });
  await autoAssignOnGo(s.id); // the same as the normal path: entering AWAITING_GO computes the automatic assignment for the GO card to show
  return { ok: true, msg: `✓ ${reqRef(s)} -> waiting on GO (${by} forced the release; the outstanding comments are on record to be decided before GO)` };
}

// Read Gate B's draft (for the lint before GO; a parse failure or a missing file gives null, and the lint is
// skipped rather than blocking by mistake).
function loadGateBEnv(s: Session): GateBEnvelope | null {
  if (!s.gate_b_draft_path || !existsSync(s.gate_b_draft_path)) return null;
  try {
    return GateBSchema.parse(JSON.parse(readFileSync(s.gate_b_draft_path, 'utf8')));
  } catch {
    return null;
  }
}

// GO in one step: create the issues and release (only for someone on the permission list). dryRun prints
// without creating; force overrides the outer-ring acceptance lint (and records why).
export async function go(
  idOrSlug: string,
  by: string,
  opts: { dryRun?: boolean; force?: boolean; assignee?: string } = {},
): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // configuration diverges per project: permissions, routing and assignment resolve against the session's project (when s is null the next line returns)
  if (!s) return { ok: false, msg: `no such session: ${idOrSlug}` };
  if (!['AWAITING_GO', 'GO_DENIED', 'WRITE_FAILED'].includes(s.state)) {
    return { ok: false, msg: `the current state is ${s.state}, so it cannot go (AWAITING_GO is required)` };
  }
  if (!inAllowList(cfg, cfg.permissions.go_approvers, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'go', by });
    return { ok: false, msg: `✗ ${by} may not GO (go_approvers=${cfg.permissions.go_approvers.join(',')})` };
  }
  // The assignment override: whoever the GO card's dropdown or --assignee names wins over the session's
  // existing assignee (the automatic recommendation). An invalid code blocks GO.
  let assigneeCode = s.assignee;
  if (opts.assignee) {
    const code = inPool(cfg.assignment, opts.assignee);
    if (!code) return { ok: false, msg: `${opts.assignee} is not a valid assignee; use one of ${cfg.assignment.pool.join('/')}` };
    assigneeCode = code;
  }
  const reassigned = !!opts.assignee && assigneeCode !== s.assignee;
  // A light check: the outer-ring acceptance lint (deterministic, before the issues are created). Empty, not
  // declarative, or a repo missing -> GO is blocked, unless --force.
  const env = loadGateBEnv(s);
  const lint = env ? lintAcceptance(env) : { ok: true, problems: [] as string[] };
  if (opts.dryRun) {
    const r = await doWrites({ ...s, assignee: assigneeCode }, { dryRun: true });
    const warn = lint.ok
      ? ''
      : `⚠ the outer-ring acceptance lint did not pass (a real GO would be blocked, unless --force):\n- ${lint.problems.join('\n- ')}\n\n`;
    return { ok: true, msg: `${warn}(dry-run) would create:\n${r.stdout}` };
  }
  if (!lint.ok && !opts.force) {
    await sessions.appendEvent(s.id, 'acceptance_lint_blocked', { problems: lint.problems });
    return {
      ok: false,
      msg: `✗ the outer-ring acceptance is not up to standard, so GO is blocked:\n- ${lint.problems.join('\n- ')}\n(fix the plan and re-run Gate B, or ./forge go ${s.slug} --user ${by} --force to override and record why)`,
    };
  }
  if (!lint.ok && opts.force) {
    await sessions.appendEvent(s.id, 'acceptance_lint_forced', { by, problems: lint.problems });
  }
  // The assignment gate: opening the work requires a DRI (even when the automatic recommendation failed or
  // the snapshot is missing, issues are never created with it empty). A dry run already returned above, so
  // this does not block the preview.
  if (!assigneeCode) {
    await sessions.appendEvent(s.id, 'go_blocked_no_assignee', { by });
    return {
      ok: false,
      msg: `✗ no DRI is assigned, so the work cannot be opened. Assign one first: ./forge assign ${s.slug} <${cfg.assignment.pool.join('|')}> --user ${by} (or pick someone from the GO card's dropdown and submit)`,
    };
  }
  if (s.state === 'GO_DENIED') await sessions.transition(s.id, 'AWAITING_GO');
  await sessions.transition(s.id, 'WRITING', {
    go_by: by,
    go_at: Date.now(),
    // A reassignment is persisted along with WRITING (overriding the automatic recommendation), and doWrites
    // writes sFresh.assignee into the issue.
    ...(reassigned ? { assignee: assigneeCode, assignee_source: 'human', assigned_by: by, assigned_at: Date.now() } : {}),
  });
  if (reassigned) await sessions.appendEvent(s.id, 'assign', { to: assigneeCode, by, source: 'human', via: 'go' });
  const sFresh = (await sessions.get(s.id))!;
  try {
    // onCreated: an issue is persisted the moment it is created, so even if labelling or approval then fails
    // into WRITE_FAILED, a retried go skips recreating it (an issue is never created twice).
    const r = await doWrites(sFresh, { onCreated: (issues) => sessions.patch(s.id, { created_issues: JSON.stringify(issues) }) });
    await sessions.patch(s.id, { created_issues: JSON.stringify(r.issues) });
    await sessions.transition(s.id, 'DONE');
    await sessions.appendEvent(s.id, 'done', { issues: r.issues });
    const links = r.issues.map((i) => `${i.repo}#${i.number} ${i.url}`).join('\n');
    await notify('done', (await sessions.get(s.id))!, { issues: r.issues });
    // The wording follows **what really happened** (as doWrites reports), no longer a config switch —
    // otherwise the native path (where publish is a no-op) would falsely claim "the PR was merged
    // automatically".
    const docNote = r.published
      ? `(the technical plan has been published to the main repo ${projectForSession(s).techDesignPublish?.base}: the PR was merged automatically)`
      : `(the technical plan document is in docs/delivery/${s.slug}/; please review it and submit it to the main repo yourself)`;
    return { ok: true, msg: `✓ ${s.slug} -> DONE. Created:\n${links}\n${docNote}` };
  } catch (e) {
    await sessions.transition(s.id, 'WRITE_FAILED', { error: String(e).slice(0, 500) });
    await sessions.appendEvent(s.id, 'error', { stage: 'writing', msg: String(e) });
    await notify('failed', (await sessions.get(s.id))!, { stage: 'creating the issues', error: String(e) });
    return { ok: false, msg: `✗ creating the issues failed: ${String(e).slice(0, 300)} (recorded as WRITE_FAILED; fix it and re-run go)` };
  }
}

export async function deny(idOrSlug: string, by: string, reason?: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // configuration diverges per project: permissions, routing and assignment resolve against the session's project (when s is null the next line returns)
  if (!s) return { ok: false, msg: `no such session: ${idOrSlug}` };
  // Sending it back is GO's inverse (go uses go_approvers), so it needs the same list — otherwise an
  // unfamiliar clicker could knock "waiting on GO" back to GO_DENIED.
  if (!inAllowList(cfg, cfg.permissions.go_approvers, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'deny', by });
    return { ok: false, msg: `✗ ${by} may not send it back (go_approvers=${cfg.permissions.go_approvers.join(',')})` };
  }
  if (s.state !== 'AWAITING_GO') return { ok: false, msg: `the current state is ${s.state}, so it cannot be denied` };
  await sessions.transition(s.id, 'GO_DENIED', { error: `denied by ${by}: ${reason ?? ''}` });
  await sessions.appendEvent(s.id, 'go_denied', { by, reason: reason ?? null });
  return { ok: true, msg: `${s.slug} rejected (revise it and go again)` };
}

// How a retry is authorised: re-running a failed gate requires the same permission as triggering that gate
// in the first place (nobody unauthorised may use retry to re-ignite a chain of paid gates or an outward
// write).
//   GATE_B_FAILED -> gate_b_allowed; GATE_C_FAILED -> gate_c_allowed;
//   GATE_D_FAILED -> pr_create_approvers; GATE_A_FAILED and everything else -> go_approvers
//   (management level, the same rule as confirm and forceGateBGo, and where the default fallback lands).
function retryAllowList(cfg: Config, state: State): string[] {
  switch (state) {
    case 'GATE_B_FAILED':
      return cfg.permissions.gate_b_allowed;
    case 'GATE_C_FAILED':
      return cfg.permissions.gate_c_allowed ?? cfg.permissions.go_approvers;
    case 'GATE_D_FAILED':
      return cfg.permissions.pr_create_approvers ?? cfg.permissions.go_approvers;
    default:
      return cfg.permissions.go_approvers;
  }
}

export async function retry(idOrSlug: string, by: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // configuration diverges per project: permissions, routing and assignment resolve against the session's project (when s is null the next line returns)
  if (!s) return { ok: false, msg: `no such session: ${idOrSlug}` };
  // A retry re-ignites a failed gate (the next tick re-runs claude, codex and the outward writes, side
  // effects and all), so it must never be unauthorised: an unfamiliar clicker, or the panel's default actor,
  // who is not on that gate's list is refused and the state does not move. The list is chosen by the failed
  // state (retryAllowList).
  const allow = retryAllowList(cfg, s.state);
  if (!inAllowList(cfg, allow, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'retry', by });
    return { ok: false, msg: `✗ ${by} may not retry (${s.state} requires ${allow.join(',')})` };
  }
  // It reuses planRetry, the same logic an automatic retry uses: GATE_A_FAILED -> the re-review point or
  // INTAKE; GATE_B_FAILED -> carry on, or a clean re-run.
  // A manual retry additionally clears the retry bookkeeping (dead_letter included), pulling back even a
  // dead letter the automation gave up on.
  const plan = planRetry(s);
  if (!plan) return { ok: false, msg: `the state ${s.state} does not need a retry` };
  await sessions.transition(s.id, plan.to, { ...plan.fields, ...RETRY_BOOKKEEPING_RESET });
  const wasDead = s.dead_letter ? ' (the dead letter has been cleared)' : '';
  return { ok: true, msg: `${s.slug} reset to ${plan.to}${wasDead}; it re-runs on the next tick` };
}
