import { readFileSync } from 'node:fs';
import { loadPrompt, render } from '../util/render.ts';
import { strictParse } from '../llm/structured.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { store } from '../store/index.ts';
const { patch, get, appendEvent } = store; // take the local implementation methods through the SessionStore seam (free functions have no `this`, so destructuring is safe)
import { VerdictSchema, FixResultSchema, GateBSchema, VERDICT_CONTRACT, FIX_CONTRACT, parseHumanAsks, findingsToMd } from './envelopes.ts';
import type { GateBEnvelope, Verdict } from './envelopes.ts';
import { gateBPaths, persistGateB, appendResidualToDoc } from './gateB.ts';
import { projectForSession } from '../projects.ts';
import { runReviewFixLoop } from '../review/reviewFixLoop.ts';
import { makeReviewFixDrivers } from '../review/drivers.ts';
import type { ReviewFixConfig, ReviewFixDrivers, ReviewFixOutcome } from '../review/reviewFixLoop.ts';
import type { Session } from '../types.ts';

function readDraft(s: Session): GateBEnvelope {
  const { draft } = gateBPaths(s.id);
  return GateBSchema.parse(JSON.parse(readFileSync(draft, 'utf8'))); // missing or broken -> throws (the worker parks at GATE_B_FAILED)
}

// Build the review/revise engine configuration specific to Gate B: the hooks read and write its own columns,
// and the artifact is persisted through the existing persistGateB.
function gateBConfig(s: Session): ReviewFixConfig<GateBEnvelope> {
  const cfg = loadConfig();
  const max = Math.max(1, cfg.runtime.adversarial.max_rounds ?? 3);
  const perTick = Math.min(max, 2); // at most 2 fix rounds per step(), so it cannot hog the tick lock
  const cur = async (): Promise<Session> => (await get(s.id))!; // read the DB fresh each time (get is async now)
  const pid = projectForSession(s).id; // the target project: prompts can be privately overridden per project (falling back to the default)
  const jstr = (v: unknown): string => JSON.stringify(v, null, 2);

  return {
    label: 'Gate B adversarial',
    maxRounds: max,
    maxRoundsPerTick: perTick,
    maxParseRepairRetries: Math.max(0, cfg.runtime.parse_repair_retries ?? 2),
    buildParseRepairPrompt: (kind, error) =>
      render(loadPrompt('partials/parse-repair.md', pid), {
        ERROR: error,
        CONTRACT: kind === 'verdict' ? VERDICT_CONTRACT : FIX_CONTRACT,
      }),
    getRound: async () => (await cur()).gate_b_round ?? 0,
    setRound: async (n) => { await patch(s.id, { gate_b_round: n, adversarial_rounds: n }); },
    getReviewerSession: async () => (await cur()).gate_b_reviewer_session,
    setReviewerSession: async (id) => { await patch(s.id, { gate_b_reviewer_session: id }); },
    getFixerSession: async () => (await cur()).gate_b_fixer_session,
    setFixerSession: async (id) => { await patch(s.id, { gate_b_fixer_session: id }); },
    maxFixFailures: Math.max(1, cfg.runtime.max_fix_failures ?? 5),
    getFixFailStreak: async () => (await cur()).gate_b_fix_fail_streak ?? 0,
    setFixFailStreak: async (n) => { await patch(s.id, { gate_b_fix_fail_streak: n }); },
    loadArtifact: async () => readDraft(await cur()),
    persistArtifact: async (art) => persistGateB(await cur(), art),
    peekHumanAnswer: async () => {
      const c = await cur();
      const pending = (c.gate_b_pending_input ?? '').trim();
      if (!pending) return null;
      let ctx = '';
      // The needs_human escalation points (resuming the fix from AWAITING_GATE_B_INPUT). The schema normalises
      // the options (an old string[] does not blow up, and o.label is never empty).
      const asks = parseHumanAsks(c.gate_b_human_asks);
      if (asks.length) {
        ctx += 'The escalation points you raised last round, awaiting the owner\'s decision:\n' +
          asks.map((a, i) => `${i + 1}. ${a.question}${a.options?.length ? ` (suggested options: ${a.options.map((o) => o.label).join(' / ')})` : ''}`).join('\n') + '\n\n';
      }
      // A "revise once more" resume out of the self-park (from GATE_B_STALLED) -> carry codex's still-unresolved
      // findings along too, so the fixer can act on them.
      try {
        const r = c.adversarial_residual ? (JSON.parse(c.adversarial_residual) as { findings?: Verdict['findings'] }) : null;
        if (r?.findings?.length) ctx += `Codex findings still unresolved:\n${findingsToMd(r.findings)}\n\n`;
      } catch { /* ignore */ }
      return `${ctx}**The owner's (M) decision**:\n${pending}`;
    },
    clearHumanAnswer: async () => {
      const c = await cur();
      await patch(s.id, { gate_b_pending_input: null, gate_b_human_asks: null }); // consumed (the fixer has already persisted the artifact)
      await appendEvent(s.id, 'gateb_human_answer_consumed', { round: c.gate_b_round });
    },
    // The pure constructors stay synchronous: they take `art` as a parameter.
    buildInitialReviewPrompt: (art) => render(loadPrompt('adversarial.md', pid), { GATE_B_OUTPUT: jstr(art) }),
    buildResumeReviewPrompt: (art) => render(loadPrompt('gateb-review-resume.md', pid), { GATE_B_OUTPUT: jstr(art) }),
    parseVerdict: (text) => strictParse(VerdictSchema, text),
    // The pure constructors stay synchronous: they read the draft through the session snapshot `s` taken when
    // the loop was entered (draft_path is fixed before the loop).
    buildInitialFixPrompt: (findings, humanAnswer) => {
      const base = render(loadPrompt('gateb-fix.md', pid), {
        GATE_B_OUTPUT: jstr(readDraft(s)),
        FINDINGS: findingsToMd(findings),
      });
      return humanAnswer ? `${humanAnswer}\n\n---\n\n${base}` : base; // defensive: the first round normally has no human answer
    },
    buildResumeFixPrompt: (findings, humanAnswer) =>
      render(loadPrompt('gateb-fix-resume.md', pid), { FINDINGS: findingsToMd(findings), HUMAN_ANSWER: humanAnswer ?? '' }),
    parseFixResult: (text) => {
      try {
        const r = strictParse(FixResultSchema, text);
        return { artifact: r.artifact, needsHuman: r.needs_human };
      } catch (e) {
        // Returning null hands it to the engine: it self-heals first (resume and feed back for a re-emit) and
        // only parks once exhausted — never let it through silently, and never drop the owner's answer. The raw
        // output is already dumped to gateb-fix.raw.txt.
        log.warn(`Gate B revision output failed to parse -> handing it to the engine to self-heal or park: ${String(e).slice(0, 160)}`);
        return null;
      }
    },
    persistResidual: async (round, used, findings) => {
      const residual = { round, used, verdict: 'CHANGES_REQUESTED', findings };
      await patch(s.id, { adversarial_residual: JSON.stringify(residual), adversarial_rounds: round });
      appendResidualToDoc(projectForSession(s).deliveryDir, (await cur()).slug, { round, used, findings: findings as Verdict['findings'] });
    },
    note: (kind, detail) => appendEvent(s.id, `gateb_${kind}`, detail),
  };
}

// The real drivers: reuses the makeReviewFixDrivers factory (the same one Gate A uses, differing only in the
// labels, the dump filenames, the skip log line and the cost column).
// Gate B additionally persists codex's token usage into gate_b_reviewer_tokens (codex --json reports no dollar
// figure, so the cost column only accrues the claude revisions).
function gateBDrivers(s: Session): ReviewFixDrivers {
  return makeReviewFixDrivers(s, {
    reviewLabel: 'Gate B · adversarial',
    reviewClaudeLabel: 'Gate B · adversarial · claude',
    fixLabel: 'Gate B · revise the design',
    reviewDumpName: 'gateb-review.raw.txt',
    fixDumpName: 'gateb-fix.raw.txt',
    skipLog: 'codex is not installed and on_missing=skip -> skipping the adversarial re-review',
    accrueFixCost: async (costUsd) => {
      const c = (await get(s.id))!;
      await patch(s.id, { gate_b_cost_usd: (c.gate_b_cost_usd ?? 0) + costUsd }); // accrue rather than overwrite the first-draft cost
    },
    persistReviewerTokens: (tokensJson) => patch(s.id, { gate_b_reviewer_tokens: tokensJson }),
  });
}

// Run a stretch of the Gate B adversarial loop (the worker calls this in ADVERSARIAL_LOOP /
// GATE_B_REVISION_REQUESTED) and return the conclusion for the worker to transition on.
export function runGateBLoop(s: Session): Promise<ReviewFixOutcome> {
  return runReviewFixLoop(gateBConfig(s), gateBDrivers(s));
}
