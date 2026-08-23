import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPrompt, render, sessionLogDir } from '../util/render.ts';
import { strictParse } from '../llm/structured.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { store } from '../store/index.ts';
const { patch, get, appendEvent } = store; // take the local implementation methods through the SessionStore seam (free functions have no `this`, so destructuring is safe)
import { GateASchema, VerdictSchema, GateAFixResultSchema, GATE_A_VERDICT_CONTRACT, GATE_A_FIX_CONTRACT, findingsToMd } from './envelopes.ts';
import type { GateAEnvelope } from './envelopes.ts';
import { projectForSession } from '../projects.ts';
import { runReviewFixLoop } from '../review/reviewFixLoop.ts';
import { makeReviewFixDrivers } from '../review/drivers.ts';
import type { ReviewFixConfig, ReviewFixDrivers, ReviewFixOutcome } from '../review/reviewFixLoop.ts';
import type { Session } from '../types.ts';

// The path to gate-a.json and its read/write helpers (the adversarial loop updates claude's re-reviewed
// final draft in place, and the codex-reviews / claude-revises cycle refreshes it repeatedly).
function gateAOutPath(s: Session): string {
  return s.gate_a_output_path ?? resolve(sessionLogDir(s.id), 'gate-a.json');
}
export function readGateAEnvelope(s: Session): GateAEnvelope {
  return GateASchema.parse(JSON.parse(readFileSync(gateAOutPath(s), 'utf8'))); // missing or broken -> throws (the worker parks at GATE_A_FAILED)
}
async function persistGateAEnvelope(s: Session, env: GateAEnvelope): Promise<void> {
  const p = gateAOutPath(s);
  writeFileSync(p, JSON.stringify(env, null, 2));
  if (s.gate_a_output_path !== p) await patch(s.id, { gate_a_output_path: p });
}

// The review/revise engine configuration for Gate A's adversarial pass: the reviewer is codex reviewing the
// PRD review verdict, and the fixer is claude revising the review envelope.
// The key difference from Gate B: it **never escalates to a human in the loop** (uncertain PRD points go
// through the PM loop) — peekHumanAnswer is always null and needsHuman is always empty.
function gateAConfig(s: Session): ReviewFixConfig<GateAEnvelope> {
  const cfg = loadConfig();
  const max = Math.max(1, cfg.runtime.adversarial.max_rounds ?? 3);
  const perTick = Math.min(max, 2); // at most 2 rounds per step(), so it cannot hog the tick lock
  const cur = async (): Promise<Session> => (await get(s.id))!; // read the DB fresh each time (get is async now)
  const pid = projectForSession(s).id; // prompts can be privately overridden per project (falling back to the default)
  const jstr = (v: unknown): string => JSON.stringify(v, null, 2);
  const prdText = s.prd_text_path && existsSync(s.prd_text_path) ? readFileSync(s.prd_text_path, 'utf8') : '';

  return {
    label: 'Gate A adversarial',
    maxRounds: max,
    maxRoundsPerTick: perTick,
    maxParseRepairRetries: Math.max(0, cfg.runtime.parse_repair_retries ?? 2),
    buildParseRepairPrompt: (kind, error) =>
      render(loadPrompt('partials/parse-repair.md', pid), {
        ERROR: error,
        CONTRACT: kind === 'verdict' ? GATE_A_VERDICT_CONTRACT : GATE_A_FIX_CONTRACT,
      }),
    getRound: async () => (await cur()).gate_a_adv_round ?? 0,
    setRound: async (n) => { await patch(s.id, { gate_a_adv_round: n }); },
    getReviewerSession: async () => (await cur()).gate_a_reviewer_session,
    setReviewerSession: async (id) => { await patch(s.id, { gate_a_reviewer_session: id }); },
    getFixerSession: async () => (await cur()).gate_a_fixer_session,
    setFixerSession: async (id) => { await patch(s.id, { gate_a_fixer_session: id }); },
    maxFixFailures: Math.max(1, cfg.runtime.max_fix_failures ?? 5),
    getFixFailStreak: async () => (await cur()).gate_a_fix_fail_streak ?? 0,
    setFixFailStreak: async (n) => { await patch(s.id, { gate_a_fix_fail_streak: n }); },
    loadArtifact: async () => readGateAEnvelope(await cur()),
    persistArtifact: async (art) => persistGateAEnvelope(await cur(), art),
    // Gate A never escalates to a human in the loop: there is no human-answer pipeline.
    peekHumanAnswer: async () => null,
    clearHumanAnswer: async () => { /* no-op: Gate A takes no human answers */ },
    // codex's first round carries the PRD plus the review verdict (after a resume, the codex session already
    // holds the PRD, so it need not be resent). A pure constructor: it takes `art` as a parameter and does not
    // read the session.
    buildInitialReviewPrompt: (art) => render(loadPrompt('gate-a-adversarial.md', pid), { PRD_TEXT: prdText, GATE_A_OUTPUT: jstr(art) }),
    buildResumeReviewPrompt: (art) => render(loadPrompt('gate-a-review-resume.md', pid), { GATE_A_OUTPUT: jstr(art) }),
    parseVerdict: (text) => strictParse(VerdictSchema, text),
    // The pure constructors stay synchronous: they read the envelope through the session snapshot `s` taken
    // when the loop was entered (output_path is fixed before the loop and only ever added, never changed,
    // inside it).
    buildInitialFixPrompt: (findings) =>
      render(loadPrompt('gate-a-fix.md', pid), { GATE_A_OUTPUT: jstr(readGateAEnvelope(s)), FINDINGS: findingsToMd(findings) }),
    buildResumeFixPrompt: (findings) =>
      render(loadPrompt('gate-a-fix-resume.md', pid), { FINDINGS: findingsToMd(findings) }),
    parseFixResult: (text) => {
      try {
        const r = strictParse(GateAFixResultSchema, text);
        return { artifact: r.artifact, needsHuman: [] }; // Gate A never escalates, so this is always empty
      } catch (e) {
        log.warn(`Gate A revision output failed to parse -> handing it to the engine to self-heal or park: ${String(e).slice(0, 160)}`);
        return null; // the engine self-heals first (resume and feed back for a re-emit) and only parks once exhausted (never let it through silently)
      }
    },
    persistResidual: async (round, used, findings) => {
      // Still unresolved at the cap -> persist into gate_a_residual (sourced from codex) for the maintainer to
      // arbitrate (shown on the needs_arbitration card).
      await patch(s.id, { gate_a_residual: JSON.stringify({ round, source: 'codex', used, findings }) });
    },
    note: (kind, detail) => appendEvent(s.id, `gatea_adv_${kind}`, detail),
  };
}

// The real drivers: reuses the makeReviewFixDrivers factory (the same one Gate B uses, differing only in the
// labels, the dump filenames, the skip log line and the cost column).
function gateADrivers(s: Session): ReviewFixDrivers {
  return makeReviewFixDrivers(s, {
    reviewLabel: 'Gate A · adversarial',
    reviewClaudeLabel: 'Gate A · adversarial · claude',
    fixLabel: 'Gate A · revise the review',
    reviewDumpName: 'gate-a-review.raw.txt',
    fixDumpName: 'gate-a-fix.raw.txt',
    skipLog: 'codex is not installed and on_missing=skip -> skipping the Gate A adversarial review',
    accrueFixCost: async (costUsd) => {
      const c = (await get(s.id))!;
      await patch(s.id, { gate_a_cost_usd: (c.gate_a_cost_usd ?? 0) + costUsd }); // accrue rather than overwrite the review cost
    },
    // Gate A does not persist a codex token column (only Gate B has gate_b_reviewer_tokens).
  });
}

// Run a stretch of the Gate A adversarial loop (the worker calls this in GATE_A_ADVERSARIAL) and return the
// conclusion for the worker to transition on.
export function runGateALoop(s: Session): Promise<ReviewFixOutcome> {
  return runReviewFixLoop(gateAConfig(s), gateADrivers(s));
}
