// The Gate D "PR adversarial review" loop: it reuses the reviewFixLoop engine, and **this is where the
// heterogeneous claude + codex cross-review really earns its keep**:
//  - review() has codex (cwd = worktree, read-only) review the base..HEAD diff -> VerdictSchema (LGTM, or
//    CHANGES_REQUESTED with findings).
//  - fix() has claude (cwd = worktree) edit files per codex's findings -> forge makes the commit -> **the local
//    CI must be green before the branch is pushed** to update the PR.
//  - The artifact under adversarial review is the worktree state: the diff is rebuilt on the spot by forge
//    (through git), never parsed as code out of the model's output (same as Gate C).
// Reusing the engine gives all of this for free: round counting, the per-tick cap, needs_human escalation,
// parking at the cap, parse self-healing, persisting the residue, and resuming both sides' sessions.
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadPrompt, render, sessionLogDir } from '../util/render.ts';
import { strictParse } from '../llm/structured.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { store } from '../store/index.ts';
const { patch, get, appendEvent } = store; // take the local implementation methods through the SessionStore seam (free functions have no `this`, so destructuring is safe)
import {
  VerdictSchema,
  GateCFixResultSchema,
  GATE_D_VERDICT_CONTRACT,
  GATE_D_FIX_CONTRACT,
  parseHumanAsks,
  findingsToMd,
} from './envelopes.ts';
import type { ImplEnvelope, Verdict } from './envelopes.ts';
import { persistGateC, readImplEnvelope, gateCContext } from './gateC.ts';
import { runCi, hasCommitsSince, diffStatSince, changedFilesSince, commitWorktree, pushWorktree, worktreeClean, resetWorktree } from './ci.ts';
import { worktreeHeadSha } from '../util/worktree.ts';
import { projectForSession } from '../projects.ts';
import { runCodex } from '../llm/runCodex.ts';
import { runClaude } from '../llm/runClaude.ts';
import { runReviewFixLoop } from '../review/reviewFixLoop.ts';
import type { ReviewFixConfig, ReviewFixDrivers, ReviewFixOutcome } from '../review/reviewFixLoop.ts';
import type { Session } from '../types.ts';

// How many bounded "CI is red -> claude fixes it itself" rounds happen inside one fix (CI is sandwiched inside
// fix): only once those are exhausted and it is still red does it park for a human. So one drv.fix call is the
// initial revision plus at most this many CI-fix rounds.
// Exported so the tick-lock grace period can estimate the longest legitimate duration of a single tick.
export const MAX_CI_FIX_ATTEMPTS = 2;

function gateDConfig(s: Session): ReviewFixConfig<ImplEnvelope> {
  const cfg = loadConfig();
  const max = Math.max(1, cfg.runtime.gate_d?.max_rounds ?? 3);
  const perTick = Math.max(1, Math.min(max, cfg.runtime.gate_d?.max_rounds_per_tick ?? 1));
  const cur = async (): Promise<Session> => (await get(s.id))!; // read the DB fresh each time (get is async now)
  const pid = projectForSession(s).id;

  return {
    label: 'Gate D PR review',
    maxRounds: max,
    maxRoundsPerTick: perTick,
    maxParseRepairRetries: Math.max(0, cfg.runtime.parse_repair_retries ?? 2),
    buildParseRepairPrompt: (kind, error) =>
      render(loadPrompt('partials/parse-repair.md', pid), {
        ERROR: error,
        CONTRACT: kind === 'verdict' ? GATE_D_VERDICT_CONTRACT : GATE_D_FIX_CONTRACT,
      }),
    getRound: async () => (await cur()).gate_d_round ?? 0,
    setRound: async (n) => {
      await patch(s.id, { gate_d_round: n });
    },
    getReviewerSession: async () => (await cur()).gate_d_reviewer_session,
    setReviewerSession: async (id) => {
      await patch(s.id, { gate_d_reviewer_session: id });
    },
    getFixerSession: async () => (await cur()).gate_d_fixer_session,
    setFixerSession: async (id) => {
      await patch(s.id, { gate_d_fixer_session: id });
    },
    maxFixFailures: Math.max(1, cfg.runtime.max_fix_failures ?? 5),
    getFixFailStreak: async () => (await cur()).gate_d_fix_fail_streak ?? 0,
    setFixFailStreak: async (n) => {
      await patch(s.id, { gate_d_fix_fail_streak: n });
    },
    loadArtifact: async () => readImplEnvelope(await cur()),
    persistArtifact: async (art) => persistGateC(await cur(), art),
    peekHumanAnswer: async () => {
      const c = await cur();
      const pending = (c.gate_d_pending_input ?? '').trim();
      if (!pending) return null;
      let ctx = '';
      const asks = parseHumanAsks(c.gate_d_human_asks);
      if (asks.length) {
        ctx += `The points you escalated last round, awaiting the owner's decision:\n${asks.map((a, i) => `${i + 1}. ${a.question}`).join('\n')}\n\n`;
      }
      try {
        const r = c.gate_d_residual ? (JSON.parse(c.gate_d_residual) as { findings?: Verdict['findings'] }) : null;
        if (r?.findings?.length) ctx += `codex findings still unresolved:\n${findingsToMd(r.findings)}\n\n`;
      } catch {
        /* a broken residue JSON is ignored */
      }
      return `${ctx}**The owner's (M) decision**:\n${pending}`;
    },
    clearHumanAnswer: async () => {
      const c = await cur();
      await patch(s.id, { gate_d_pending_input: null, gate_d_human_asks: null });
      await appendEvent(s.id, 'gated_human_answer_consumed', { round: c.gate_d_round });
    },
    // The pure constructors stay synchronous: they use the session snapshot `s` taken when the loop was
    // entered (context, base_sha and worktree_path are all fixed before the loop).
    buildInitialReviewPrompt: () =>
      render(loadPrompt('gate-d-pr-review.md', pid), {
        CONTEXT: gateCContext(s),
        BASE: readImplEnvelope(s).base_sha,
        WORKTREE: s.worktree_path ?? '',
      }),
    buildResumeReviewPrompt: () =>
      render(loadPrompt('gate-d-pr-review-resume.md', pid), {
        BASE: readImplEnvelope(s).base_sha,
        WORKTREE: s.worktree_path ?? '',
      }),
    parseVerdict: (text) => strictParse(VerdictSchema, text),
    buildInitialFixPrompt: (findings, humanAnswer) => {
      const base = render(loadPrompt('gate-d-fix.md', pid), {
        FINDINGS: findingsToMd(findings),
        WORKTREE: s.worktree_path ?? '',
      });
      return humanAnswer ? `${humanAnswer}\n\n---\n\n${base}` : base;
    },
    buildResumeFixPrompt: (findings, humanAnswer) =>
      render(loadPrompt('gate-d-fix-resume.md', pid), {
        FINDINGS: findingsToMd(findings),
        HUMAN_ANSWER: humanAnswer ?? '',
        WORKTREE: s.worktree_path ?? '',
      }),
    parseFixResult: (text) => {
      try {
        const r = strictParse(GateCFixResultSchema, text);
        // Rebuild the envelope: claude edited files in the worktree (the code is not in `text`), so the diff
        // and the file list are read live from git.
        // This parse hook is synchronous: it reads the envelope through the session snapshot `s` (draft_path is
        // fixed before the loop and does not change inside it).
        const env = readImplEnvelope(s);
        const wt = env.worktree_path;
        const merged: ImplEnvelope = {
          ...env,
          implemented: hasCommitsSince(wt, env.base_sha),
          diff_stat: diffStatSince(wt, env.base_sha),
          files_changed: changedFilesSince(wt, env.base_sha),
          last_summary: r.summary,
        };
        return { artifact: merged, needsHuman: r.needs_human };
      } catch (e) {
        log.warn(`Gate D revision output failed to parse -> handing it to the engine to self-heal or park: ${String(e).slice(0, 160)}`);
        return null;
      }
    },
    persistResidual: async (round, used, findings) => {
      await patch(s.id, { gate_d_residual: JSON.stringify({ round, used, verdict: 'CHANGES_REQUESTED', findings }) });
    },
    note: (kind, detail) => appendEvent(s.id, `gated_${kind}`, detail),
  };
}

function gateDDrivers(s: Session): ReviewFixDrivers {
  const proj = projectForSession(s);
  const cur = async (): Promise<Session> => (await get(s.id))!;
  const dump = (name: string, raw: string): void => {
    try {
      writeFileSync(resolve(sessionLogDir(s.id), name), raw);
    } catch {
      /* a failed dump must not block the flow */
    }
  };
  return {
    // codex reviews the worktree's diff (cwd = worktree, read-only). on_missing degrades, skips or errors
    // exactly as it does in Gate B.
    review: async (prompt, opts) => {
      const cfg = loadConfig();
      const wt = (await cur()).worktree_path ?? proj.root;
      if (cfg.runtime.adversarial.reviewer === 'codex') {
        const c = await runCodex(
          prompt,
          opts.sessionId ? { threadId: opts.sessionId, label: 'Gate D · PR review', cwd: wt } : { label: 'Gate D · PR review', readOnly: true, cwd: wt },
        );
        dump('gated-review.raw.txt', c.raw ?? '');
        if (c.ok) {
          if (c.tokens) await patch(s.id, { gate_d_reviewer_tokens: JSON.stringify(c.tokens) });
          return { ok: true, text: c.result, sessionId: c.threadId, available: true, used: 'codex' };
        }
        if (!c.available) {
          if (cfg.runtime.adversarial.on_missing === 'skip') {
            log.warn('codex is not installed and on_missing=skip -> skipping the Gate D PR adversarial review');
            return { ok: false, text: '', sessionId: null, available: false, used: 'codex' };
          }
          if (cfg.runtime.adversarial.on_missing === 'error') throw new Error('codex is unavailable and on_missing=error');
          log.warn('codex is not installed; degrading to a claude self-review of the PR (weaker independence - install codex and it switches back automatically)');
        } else {
          log.warn(`The Gate D codex review failed (${c.error}); degrading to claude`);
        }
      }
      // The degraded claude self-review (cwd = worktree, no session continuation, so every round resends -
      // weaker independence, used only as a fallback when codex is missing; a failure propagates up and parks
      // rather than being let through silently).
      // Reviewing a whole PR diff is a heavy downstream call too, so it uses gate_d.claude_timeout_sec (falling
      // back to the global value when unset).
      const r = await runClaude(prompt, { label: 'Gate D · PR review · claude', cwd: wt, timeoutSec: loadConfig().runtime.gate_d?.claude_timeout_sec });
      dump('gated-review.raw.txt', r.raw ?? '');
      if (!r.ok) return { ok: false, text: '', sessionId: null, available: true, used: 'claude', error: r.error };
      return { ok: true, text: r.result, sessionId: null, available: true, used: 'claude' };
    },
    // claude edits the worktree per the findings -> forge commits -> **it only pushes once CI is green and the
    // worktree is clean** (a red or unverified state is never pushed into the PR). CI is sandwiched inside fix:
    // when it is red, claude gets the CI summary and fixes it for a bounded number of rounds; if those are
    // exhausted, an infrastructure error occurs, or anything else stops it reaching "CI green and pushed", the
    // worktree is **rolled back to the pre-fix HEAD** before parking or pausing. That guarantees "the committed
    // HEAD that review-first sees is always the CI-green one" - otherwise the next tick's codex could LGTM a red
    // HEAD and walk straight past the CI gate (Codex Gate D blocker).
    fix: async (prompt, opts) => {
      const env = readImplEnvelope(await cur());
      const wt = env.worktree_path || proj.root;
      const pid = projectForSession(await cur()).id;
      const ciScript = proj.scripts.ci ? resolve(wt, proj.scripts.ci) : undefined;
      const ciTimeout = (loadConfig().runtime.gate_d?.ci_timeout_sec ?? 1800) * 1000;
      const round = ((await cur()).gate_d_round ?? 0) + 1;
      const preHead = worktreeHeadSha(wt); // the rollback anchor = the last CI-green HEAD that was pushed (Gate C's green state, or the commit pushed by the previous Gate D round)
      if (!preHead) throw new Error('Gate D revision: the worktree HEAD could not be read, so no rollback point can be established -> parking');
      const claudeTimeout = loadConfig().runtime.gate_d?.claude_timeout_sec; // a PR-level fix is heavy; falls back to the global value when unset
      let sid = opts.sessionId;
      const runStep = (p: string): Promise<Awaited<ReturnType<typeof runClaude>>> => {
        if (sid) return runClaude(p, { label: 'Gate D · revise', resume: sid, cwd: wt, timeoutSec: claudeTimeout });
        sid = randomUUID();
        return runClaude(p, { label: 'Gate D · revise', sessionId: sid, cwd: wt, timeoutSec: claudeTimeout });
      };
      // Reset to preHead; if the reset fails, record a poison pill and throw (a red or dirty HEAD must never
      // make it back to review-first).
      // The key point: when the reset itself fails, the worktree is left in an "unconfirmed reset" state.
      // Throwing is not enough - after the worker parks at GATE_D_FAILED, planRetry sends a GATE_D_FAILED with
      // an open PR straight back to GATE_D_LOOP (whichever way that failure was classified), which would let a
      // red or dirty HEAD into the next review-first and bypass the CI-green precondition (Codex Gate D
      // blocker). So it records gate_d_rollback_to, and recoverPendingRollback forces a confirmed reset before
      // the loop is entered again.
      const rollback = async (): Promise<void> => {
        const r = resetWorktree(wt, preHead);
        await appendEvent(s.id, 'gated_rollback', { to: preHead.slice(0, 12), ok: r.ok, output: r.output.slice(0, 120) });
        if (!r.ok) {
          await patch(s.id, { gate_d_rollback_to: preHead }); // the poison pill: the reset is unconfirmed, so it must be confirmed before the loop runs again
          throw new Error(`Gate D failed to roll the worktree back to ${preHead.slice(0, 12)} -> parking (so a red HEAD cannot slip into a later review): ${r.output.slice(0, 160)}`);
        }
      };
      const bail = async (msg: string): Promise<never> => {
        await rollback();
        throw new Error(msg);
      };

      let res = await runStep(prompt);
      dump('gated-fix.raw.txt', res.raw ?? '');
      // A failed claude call (transient) -> roll back and return ok:false: the engine pauses and retries
      // (without advancing the round), and nothing half-finished is left in HEAD or the worktree.
      if (!res.ok) {
        await rollback();
        return { ok: false, text: res.result, sessionId: null, costUsd: res.costUsd, error: res.error };
      }
      if (res.costUsd != null) await patch(s.id, { gate_d_cost_usd: ((await cur()).gate_d_cost_usd ?? 0) + res.costUsd });

      // Commit and run CI; when it is red, fix it for a bounded number of rounds. A failed commit, a tree that
      // is not clean before or after CI, CI failing to run, or the rounds being exhausted -> roll back and park.
      for (let attempt = 0; ; attempt++) {
        const cm = commitWorktree(wt, `forge(gate D ${s.slug}): round ${round}${attempt ? ` ci-fix ${attempt}` : ' fix'}`);
        await appendEvent(s.id, 'gated_commit', { ok: cm.ok, committed: cm.committed, attempt, output: cm.output.slice(0, 160) });
        if (!cm.ok) await bail(`Gate D failed to make the commit -> parking (the worktree may be dirty): ${cm.output.slice(0, 200)}`);
        if (!worktreeClean(wt)) await bail('the Gate D worktree is not clean after the commit -> parking (CI must verify HEAD, not a dirty tree)');

        const ci = await runCi(wt, ciScript, { base: env.base_sha || env.base_ref || undefined, timeoutMs: ciTimeout });
        dump('gated-ci.raw.txt', ci.summary);
        if (!ci.ran) await bail(`Gate D CI could not be run (infrastructure): ${ci.summary.slice(0, 200)}`);
        if (ci.ok) {
          // Check cleanliness once more after CI goes green: if the delegated CI script modified tracked files
          // itself (codegen or formatting) and still exited 0, what CI verified was HEAD-plus-dirt while only
          // HEAD gets pushed - so "what CI verified" would still differ from "what is pushed" (Codex, second
          // review, blocker).
          if (!worktreeClean(wt)) await bail('the Gate D worktree was dirtied after CI -> parking (what CI verified is not the HEAD being pushed; CI must not modify tracked files)');
          break; // green and clean on both sides -> HEAD is exactly the verified commit, so push it
        }
        if (attempt >= MAX_CI_FIX_ATTEMPTS) await bail(`the local Gate D CI is still red after the revision plus ${attempt} self-fix round(s) -> parking for the owner (a red state is never pushed into the PR): ${ci.summary.slice(0, 200)}`);
        // Red: hand claude the CI summary for another fix round (resuming the same session). If that self-fix
        // claude call drops out, roll back and pause (a red commit must never be left at HEAD).
        res = await runStep(render(loadPrompt('gate-d-ci-fix.md', pid), { CI: ci.summary.slice(0, 3000), WORKTREE: wt }));
        dump('gated-fix.raw.txt', res.raw ?? '');
        if (!res.ok) {
          await rollback();
          return { ok: false, text: res.result, sessionId: null, costUsd: res.costUsd, error: res.error };
        }
        if (res.costUsd != null) await patch(s.id, { gate_d_cost_usd: ((await cur()).gate_d_cost_usd ?? 0) + res.costUsd });
      }

      const pushed = pushWorktree(wt);
      if (!pushed.ok) await bail(`Gate D failed to push the branch to update the PR: ${pushed.output.slice(0, 200)}`);
      await appendEvent(s.id, 'gated_pushed', { round });
      return { ok: true, text: res.result, sessionId: sid, costUsd: res.costUsd };
    },
  };
}

// The poison-pill gate that runs before the loop: a failed rollback in the previous revision round leaves
// gate_d_rollback_to behind (the worktree is in an "unconfirmed reset" state).
// Whether classifyError judged that failure transient (reconcile retries it with a backoff) or permanent (a
// human retries it), planRetry sends a GATE_D_FAILED with an open PR back to GATE_D_LOOP - so without forcing a
// confirmed reset before review-first runs, a red or dirty HEAD would enter the review and bypass the CI-green
// precondition.
// Hence: if the mark is set -> resetWorktree first (which re-checks cleanliness internally) -> only clear the
// mark and continue on success; on failure, throw and stay parked or go to the dead-letter queue.
// Continuing is gated on the deterministic fact "the reset was confirmed", never on classifying error text
// (Codex Gate D blocker).
async function recoverPendingRollback(s: Session): Promise<void> {
  const c = (await get(s.id))!;
  const target = (c.gate_d_rollback_to ?? '').trim();
  if (!target) return;
  const wt = c.worktree_path;
  if (!wt) {
    await appendEvent(s.id, 'gated_rollback_recover', { ok: false, reason: 'missing_worktree_path', to: target.slice(0, 12) });
    throw new Error('Gate D rollback recovery: the mark demands a reset but worktree_path is missing -> staying parked');
  }
  const r = resetWorktree(wt, target);
  await appendEvent(s.id, 'gated_rollback_recover', { to: target.slice(0, 12), ok: r.ok, output: r.output.slice(0, 120) });
  if (!r.ok) throw new Error(`Gate D rollback recovery failed: the worktree still cannot be reset to ${target.slice(0, 12)} -> staying parked (a red or dirty HEAD must never enter the review): ${r.output.slice(0, 160)}`);
  await patch(s.id, { gate_d_rollback_to: null }); // the reset is confirmed -> clear the poison pill and continue into review-first
}

// Run a stretch of the Gate D PR adversarial loop (the worker calls this in GATE_D_LOOP /
// GATE_D_REVISION_REQUESTED) and return the conclusion for the worker to transition on.
// It is async so that a synchronous throw from recoverPendingRollback also becomes a promise rejection (the
// worker's await-in-try catches both the same way and parks).
export async function runGateDLoop(s: Session): Promise<ReviewFixOutcome> {
  await recoverPendingRollback(s); // the poison-pill gate: a worktree with an unconfirmed reset never enters review-first
  return runReviewFixLoop(gateDConfig(s), gateDDrivers(s));
}
