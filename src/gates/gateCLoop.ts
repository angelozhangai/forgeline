// The Gate C "implement / CI" loop: it reuses the reviewFixLoop engine, but **the reviewer is deterministic
// CI and acceptance** rather than codex:
//  - review() runs the project's delegated CI inside the worktree. Green -> LGTM; red or not-yet-implemented ->
//    CHANGES_REQUESTED (with the failure summary as the findings).
//  - fix() has claude edit files inside the worktree (cwd = worktree) and forge makes the commit (claude only
//    writes code; forge owns git).
//  - The artifact under adversarial review is the worktree state: the diff and the CI result are rebuilt on the
//    spot by forge (through git and CI), never parsed as code out of the model's output.
// Reusing the engine gives all of this for free: round counting, the per-tick cap, needs_human escalation,
// parking at the cap, self-healing when the revision output does not parse, and persisting the residue.
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadPrompt, render, sessionLogDir } from '../util/render.ts';
import { strictParse } from '../llm/structured.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { store } from '../store/index.ts';
const { patch, get, appendEvent } = store; // take the local implementation methods through the SessionStore seam (free functions have no `this`, so destructuring is safe)
import { GateCFixResultSchema, GATE_C_FIX_CONTRACT, parseHumanAsks, findingsToMd } from './envelopes.ts';
import type { ImplEnvelope } from './envelopes.ts';
import { persistGateC, readImplEnvelope, gateCContext } from './gateC.ts';
import { runCi, hasCommitsSince, diffStatSince, changedFilesSince, commitWorktree, worktreeClean } from './ci.ts';
import { projectForSession } from '../projects.ts';
import { runClaude } from '../llm/runClaude.ts';
import { runReviewFixLoop } from '../review/reviewFixLoop.ts';
import type { ReviewFixConfig, ReviewFixDrivers, ReviewFixOutcome, ReviewVerdict } from '../review/reviewFixLoop.ts';
import type { Session } from '../types.ts';

// The base for CI's affected computation: prefer the **pinned base_sha** (the worktree is pinned at exactly
// that sha); base_ref is only a fallback.
// It must never default to the moving ref base_ref=origin/<branch> - when a concurrent refresh() advances it,
// "affected" is computed against a future baseline, which tests the wrong things, skips others, and can go
// falsely green (Codex B2). Exported for unit tests.
export function ciBase(env: Pick<ImplEnvelope, 'base_sha' | 'base_ref'>): string | undefined {
  return env.base_sha || env.base_ref || undefined;
}

// The status text produced by the CI driver -> a ReviewVerdict (deterministic and never throws, which is why
// it does not go through the schema self-healing path). Exported for unit tests.
export function ciTextToVerdict(text: string): ReviewVerdict {
  let o: { state?: string; summary?: string };
  try {
    o = JSON.parse(text) as { state?: string; summary?: string };
  } catch {
    o = { state: 'ci_red', summary: text };
  }
  if (o.state === 'green') return { verdict: 'LGTM', findings: [] };
  const issue =
    o.state === 'unimplemented'
      ? 'Not implemented yet: the worktree has no commits after base. Implement per the tech design/issue and land the changes in files.'
      : `Local CI/acceptance failed:\n${(o.summary ?? '').slice(0, 3000)}`;
  return { verdict: 'CHANGES_REQUESTED', findings: [{ severity: 'high', issue, where: 'worktree', fix: '', evidence: '' }] };
}

function gateCConfig(s: Session): ReviewFixConfig<ImplEnvelope> {
  const cfg = loadConfig();
  const max = Math.max(1, cfg.runtime.gate_c?.max_rounds ?? 4);
  const perTick = Math.max(1, Math.min(max, cfg.runtime.gate_c?.max_rounds_per_tick ?? 1));
  const cur = async (): Promise<Session> => (await get(s.id))!; // read the DB fresh each time (get is async now)
  const pid = projectForSession(s).id;

  return {
    label: 'Gate C implementation',
    maxRounds: max,
    maxRoundsPerTick: perTick,
    maxParseRepairRetries: Math.max(0, cfg.runtime.parse_repair_retries ?? 2),
    buildParseRepairPrompt: (_kind, error) =>
      render(loadPrompt('partials/parse-repair.md', pid), { ERROR: error, CONTRACT: GATE_C_FIX_CONTRACT }),
    getRound: async () => (await cur()).gate_c_round ?? 0,
    setRound: async (n) => {
      await patch(s.id, { gate_c_round: n });
    },
    // CI is the reviewer - stateless and session-less, so both reviewer-session hooks are no-ops.
    getReviewerSession: async () => null,
    setReviewerSession: async () => {
      /* CI has no session */
    },
    getFixerSession: async () => (await cur()).gate_c_fixer_session,
    setFixerSession: async (id) => {
      await patch(s.id, { gate_c_fixer_session: id });
    },
    maxFixFailures: Math.max(1, cfg.runtime.max_fix_failures ?? 5),
    getFixFailStreak: async () => (await cur()).gate_c_fix_fail_streak ?? 0,
    setFixFailStreak: async (n) => {
      await patch(s.id, { gate_c_fix_fail_streak: n });
    },
    loadArtifact: async () => readImplEnvelope(await cur()),
    persistArtifact: async (art) => persistGateC(await cur(), art),
    peekHumanAnswer: async () => {
      const c = await cur();
      const pending = (c.gate_c_pending_input ?? '').trim();
      if (!pending) return null;
      let ctx = '';
      const asks = parseHumanAsks(c.gate_c_human_asks);
      if (asks.length) {
        ctx += `The points you escalated last round, awaiting the owner's decision:\n${asks.map((a, i) => `${i + 1}. ${a.question}`).join('\n')}\n\n`;
      }
      return `${ctx}**The owner's (M) decision**:\n${pending}`;
    },
    clearHumanAnswer: async () => {
      const c = await cur();
      await patch(s.id, { gate_c_pending_input: null, gate_c_human_asks: null });
      await appendEvent(s.id, 'gatec_human_answer_consumed', { round: c.gate_c_round });
    },
    // The CI reviewer takes no prompt (the driver ignores it). The pure constructors stay synchronous.
    buildInitialReviewPrompt: () => '',
    buildResumeReviewPrompt: () => '',
    parseVerdict: (text) => ciTextToVerdict(text),
    // The pure constructors stay synchronous: they use the session snapshot `s` taken when the loop was
    // entered (context and worktree_path are fixed before the loop).
    buildInitialFixPrompt: (findings, humanAnswer) => {
      const base = render(loadPrompt('gate-c-implement.md', pid), {
        CONTEXT: gateCContext(s),
        FINDINGS: findingsToMd(findings),
        WORKTREE: s.worktree_path ?? '',
      });
      return humanAnswer ? `${humanAnswer}\n\n---\n\n${base}` : base; // defensive: the first round normally has no human answer
    },
    buildResumeFixPrompt: (findings, humanAnswer) =>
      render(loadPrompt('gate-c-fix-resume.md', pid), {
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
        log.warn(`Gate C revision output failed to parse -> handing it to the engine to self-heal or park: ${String(e).slice(0, 160)}`);
        return null; // the engine self-heals first (resume and feed back for a re-emit) and only parks once exhausted (never let it through silently)
      }
    },
    persistResidual: async (round, used, findings) => {
      await patch(s.id, { gate_c_residual: JSON.stringify({ round, used, verdict: 'CHANGES_REQUESTED', findings }) });
    },
    note: (kind, detail) => appendEvent(s.id, `gatec_${kind}`, detail),
  };
}

function gateCDrivers(s: Session): ReviewFixDrivers {
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
    review: async () => {
      const env = readImplEnvelope(await cur());
      const wt = env.worktree_path;
      // No commits after base means nothing has been implemented yet -> skip CI and return "unimplemented"
      // outright, which forces claude to start working.
      if (!hasCommitsSince(wt, env.base_sha)) {
        return { ok: true, text: JSON.stringify({ state: 'unimplemented' }), sessionId: null, available: true, used: 'ci' };
      }
      const ciScript = proj.scripts.ci ? resolve(wt, proj.scripts.ci) : undefined;
      const ci = await runCi(wt, ciScript, {
        base: ciBase(env), // the pinned sha wins; never a moving ref (Codex B2, see ciBase)
        timeoutMs: (loadConfig().runtime.gate_c?.ci_timeout_sec ?? 1800) * 1000,
      });
      dump('gatec-ci.raw.txt', ci.summary);
      // Refresh the envelope's CI fields (for display, best-effort).
      try {
        await persistGateC(await cur(), { ...env, ci_ok: ci.ok, ci_summary: ci.summary.slice(0, 2000), implemented: true, diff_stat: diffStatSince(wt, env.base_sha) });
      } catch {
        /* a failed display refresh must not block the flow */
      }
      // CI failing to run at all (a missing script, a spawn failure, a timeout) is an infrastructure error ->
      // return ok:false so it propagates up and parks (never treat it as a red result and send claude off to
      // fix nothing).
      if (!ci.ran) {
        return { ok: false, text: '', sessionId: null, available: true, used: 'ci', error: ci.summary };
      }
      // CI went green but CI itself dirtied the worktree (codegen or formatting touched tracked files) -> what
      // CI verified was HEAD-plus-dirt, while the artifact and the PR are HEAD, so "CI green" is a false
      // positive for HEAD. Park it as an infrastructure/contract error (CI must not modify tracked files - the
      // same blocker Gate D enforces).
      if (ci.ok && !worktreeClean(wt)) {
        // Correct the display: the refresh above set ci_ok:true from ci.ok, but that is a false positive for
        // HEAD -> set it back to false and say why, so the parked session does not mislead whoever debugs it
        // (Codex SF).
        try {
          await persistGateC(await cur(), { ...env, ci_ok: false, ci_summary: `green-but-dirty rejected (CI went green but dirtied the worktree; CI must not modify tracked files): ${ci.summary.slice(0, 1800)}`, implemented: true });
        } catch {
          /* a failed display refresh must not block the flow */
        }
        return { ok: false, text: '', sessionId: null, available: true, used: 'ci', error: `CI went green but dirtied the worktree (CI must not modify tracked files): ${ci.summary.slice(0, 200)}` };
      }
      return { ok: true, text: JSON.stringify({ state: ci.ok ? 'green' : 'ci_red', summary: ci.summary }), sessionId: null, available: true, used: 'ci' };
    },
    fix: async (prompt, opts) => {
      const wt = (await cur()).worktree_path ?? proj.root;
      // Writing code downstream is far heavier than reviewing a document upstream, so the per-call timeout
      // comes from gate_c.claude_timeout_sec (falling back to the global value when unset).
      const timeoutSec = loadConfig().runtime.gate_c?.claude_timeout_sec;
      let sid = opts.sessionId;
      let res: Awaited<ReturnType<typeof runClaude>>;
      if (sid) {
        res = await runClaude(prompt, { label: 'Gate C · implement', resume: sid, cwd: wt, timeoutSec });
      } else {
        sid = randomUUID(); // pin a new session so the work can be resumed
        res = await runClaude(prompt, { label: 'Gate C · implement', sessionId: sid, cwd: wt, timeoutSec });
      }
      dump('gatec-fix.raw.txt', res.raw ?? '');
      if (res.ok) {
        // claude only writes code, so forge makes a WIP commit (forge owns git). --no-verify skips the target
        // project's own pre-commit hooks - the real gate is the project's CI script.
        const round = ((await cur()).gate_c_round ?? 0) + 1;
        const cm = commitWorktree(wt, `forge(gate C ${s.slug}): round ${round}`);
        await appendEvent(s.id, 'gatec_commit', { ok: cm.ok, committed: cm.committed, output: cm.output.slice(0, 160) });
        if (res.costUsd != null) await patch(s.id, { gate_c_cost_usd: ((await cur()).gate_c_cost_usd ?? 0) + res.costUsd });
        // A failed commit or a dirty worktree throws and parks: otherwise the reviewer's CI would verify a
        // dirty working tree rather than HEAD (the same blocker Gate D enforces).
        if (!cm.ok) throw new Error(`Gate C failed to make the commit -> parking (the worktree may be dirty): ${cm.output.slice(0, 200)}`);
        if (!worktreeClean(wt)) throw new Error('the Gate C worktree is still not clean after the commit -> parking (CI must verify HEAD, not a dirty tree)');
      }
      return { ok: res.ok, text: res.result, sessionId: res.ok ? sid : null, costUsd: res.costUsd, error: res.error };
    },
  };
}

// Run a stretch of the Gate C implement/CI loop (the worker calls this in GATE_C_LOOP /
// GATE_C_REVISION_REQUESTED) and return the conclusion for the worker to transition on.
export function runGateCLoop(s: Session): Promise<ReviewFixOutcome> {
  return runReviewFixLoop(gateCConfig(s), gateCDrivers(s));
}
