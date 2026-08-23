// Guarding the semantics of the acceptance (#3): beyond the structural lint (that contracts and scenarios
// exist), an LLM judge scores the **semantic quality** — does the acceptance really cover the PRD's critical
// paths, and is it testable (a declarative Given/When/Then with assertions, rather than imperative
// click-a-button steps).
// The acceptance is the baseline that drift reconciliation compares against: if the baseline itself is badly
// written, no amount of accuracy in the reconciliation helps.
//
// The judge costs money (one more claude call), so it only runs when a gate:b fixture sets
// `acceptance_judge` explicitly, and only under `forge eval`.
// Turning its result into checks (acceptanceJudgeChecks) and parsing it (parseAcceptanceJudge) are pure
// logic and run in CI.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { project } from '../projects.ts';
import { loadPrompt, render } from '../util/render.ts';
import { runClaude } from '../llm/runClaude.ts';
import { strictParse } from '../llm/structured.ts';
import type { CheckResult, EvalExpect } from './expectations.ts';

export const AcceptanceJudgeSchema = z
  .object({
    coverage: z.number().default(0), // 0-100: how well the acceptance covers the PRD's critical paths
    testability: z.number().default(0), // 0-100: testability (declarative, has assertions, the contract is concrete)
    declarative: z.boolean().default(false), // whether it is declarative (Given/When/Then describing an outcome, rather than imperative steps)
    issues: z.array(z.string()).default([]), // the concrete problems (a coverage gap, an imperative step, a vague contract …)
    verdict: z.enum(['good', 'weak']).default('weak'),
  })
  .strict();
export type AcceptanceJudge = z.infer<typeof AcceptanceJudgeSchema>;

export type JudgeExpect = NonNullable<EvalExpect['acceptance_judge']>;

// Pure: the judge's result plus the thresholds -> checks and metrics. evalGateB appends these on top of the
// structural checks.
export function acceptanceJudgeChecks(j: AcceptanceJudge, x: JudgeExpect): { checks: CheckResult[]; metrics: Record<string, number> } {
  const checks: CheckResult[] = [];
  if (x.min_coverage != null) checks.push({ name: `acceptance coverage >= ${x.min_coverage}`, pass: j.coverage >= x.min_coverage, detail: `the judge gave ${j.coverage}${j.issues.length ? `; problems: ${j.issues.slice(0, 2).join('; ')}` : ''}` });
  if (x.min_testability != null) checks.push({ name: `acceptance testability >= ${x.min_testability}`, pass: j.testability >= x.min_testability, detail: `the judge gave ${j.testability}` });
  if (x.require_declarative) checks.push({ name: 'acceptance is declarative (not imperative steps)', pass: j.declarative, detail: j.declarative ? 'yes' : 'judged imperative / a list of operations' });
  return { checks, metrics: { acceptance_coverage: j.coverage, acceptance_testability: j.testability } };
}

// Costs money: render the judge prompt -> a real claude call (in a neutral temporary cwd) -> parse. Returns
// ok or an error rather than throwing, so the caller can turn it into a failing check without aborting the
// whole round.
// It **always returns costUsd** — even a parse failure or a claude error has already cost money — so the
// caller can add it to the sample's cost and the total (and what is persisted) does not under-count this
// call.
export async function judgeAcceptance(prdTruth: string, acceptanceMd: string): Promise<({ ok: true; judge: AcceptanceJudge } | { ok: false; error: string }) & { costUsd: number | null }> {
  const proj = project();
  const prompt = render(loadPrompt('eval/acceptance-judge.md', proj.id), { PRD_TRUTH: prdTruth, ACCEPTANCE: acceptanceMd });
  const tmp = mkdtempSync(join(tmpdir(), 'forge-judge-'));
  try {
    const res = await runClaude(prompt, { label: 'eval-judge:acceptance', cwd: tmp });
    if (!res.ok) return { ok: false, error: `the judge's claude call failed: ${res.error ?? 'unknown'}`, costUsd: res.costUsd };
    try {
      return { ok: true, judge: strictParse(AcceptanceJudgeSchema, res.result), costUsd: res.costUsd };
    } catch (e) {
      return { ok: false, error: `the judge's output does not match the contract: ${String(e).slice(0, 140)}`, costUsd: res.costUsd };
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
