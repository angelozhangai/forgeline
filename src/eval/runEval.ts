// The part of the golden eval that **costs money**: running the real Gate A prompt (a real claude call) over
// a fixture PRD, parsing the output and comparing it against the expectations.
// ⚠️ It calls claude for real and costs money, so it is **not part of npm run ci** and only a manual
// `forge eval` triggers it.
//
// The design: reuse the **exact production** gate-a.md template, output-contract and GateASchema (they are
// the asset being protected), swapping only the code source-of-truth block for a synthetic one and using a
// neutral temporary cwd — isolated, reproducible and free of side effects (nothing is written to the
// database, nothing is sent to Feishu, git is untouched).
// What it measures is "the shape of what the prompt and the review method produce for a given PRD"; it
// deliberately does not attach a live code source of truth (that is another layer, left for later).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../projects.ts';
import { loadPrompt, render } from '../util/render.ts';
import { formatZodError } from '../llm/structured.ts';
import { extractJsonBlock } from '../util/json.ts';
import { runClaude } from '../llm/runClaude.ts';
import { GateASchema, GateBSchema } from '../gates/envelopes.ts';
import { SIZE_RUBRIC } from '../util/sizing.ts';
import { SCORE_RUBRIC } from '../util/scoring.ts';
import { loadFixtures, checkGateA, checkGateB, missingRawFields, missingGateBFields, type Fixture, type FixtureResult, type CheckResult } from './expectations.ts';
import { aggregateFixture, summarize, type AggregatedFixture, type EvalReport } from './aggregate.ts';
import { judgeAcceptance, acceptanceJudgeChecks } from './judge.ts';
import { acceptanceMarkdown } from '../util/acceptance.ts';

// The code source-of-truth placeholder (eval's isolated mode) — it tells the model plainly that no code is
// fetched this round and the output comes from the PRD or source-of-truth text alone.
const EVAL_FRESHNESS =
  '(eval offline mode: code source-of-truth fetching is skipped this round — produce from the text alone. This eval protects the output shape of the gate prompts/review method; it does not represent production code alignment.)';

// Build the **same** Gate A prompt production's runGateA does, replacing only the code source-of-truth block
// and the slug (which becomes the fixture's name).
export function buildGateAEvalPrompt(name: string, prdText: string): string {
  const proj = project();
  return render(loadPrompt('gate-a.md', proj.id), {
    REPO_FRESHNESS: EVAL_FRESHNESS,
    SLUG: name,
    PRD_TEXT: prdText,
    OUTPUT_CONTRACT: render(loadPrompt('partials/output-contract.md', proj.id), { SIZE_RUBRIC, SCORE_RUBRIC }),
  });
}

// Build the **same** Gate B prompt production's runGateB does, with the fixture's prd-truth.md as input.
export function buildGateBEvalPrompt(name: string, prdTruth: string): string {
  const proj = project();
  return render(loadPrompt('gate-b.md', proj.id), { REPO_FRESHNESS: EVAL_FRESHNESS, SLUG: name, PRD_TRUTH: prdTruth });
}

// One judgement: if the shape holds, the checks and the key metrics (plus the extraCost of any additional
// claude call such as the judge); otherwise, the reason it degraded.
type Judgement = { error: string } | { checks: CheckResult[]; metrics: Record<string, number>; extraCost?: number | null };

// The shared eval skeleton: a neutral temporary cwd (isolated, reproducible, no side effects) -> a real
// claude call -> extract the raw JSON -> hand it to the judge (which may be async, as Gate B's LLM judge
// needs).
async function evalOnce(fx: Fixture, buildPrompt: (name: string, input: string) => string, label: string, judge: (raw: unknown, fx: Fixture) => Judgement | Promise<Judgement>): Promise<FixtureResult> {
  const tmp = mkdtempSync(join(tmpdir(), 'forge-eval-'));
  try {
    const res = await runClaude(buildPrompt(fx.name, fx.inputText), { label, cwd: tmp });
    const base = { name: fx.name, desc: fx.expect.desc, checks: [] as CheckResult[], costUsd: res.costUsd };
    if (!res.ok) return { ...base, schemaValid: false, error: `the claude call failed: ${res.error ?? 'unknown'}` };
    let raw: unknown;
    try {
      raw = extractJsonBlock(res.result); // extract the raw JSON before zod injects any defaults, so the shape contract can check for explicit fields
    } catch (e) {
      return { ...base, schemaValid: false, error: `the output has no parseable JSON: ${String(e).slice(0, 120)}` };
    }
    const v = await judge(raw, fx);
    if ('error' in v) return { ...base, schemaValid: false, error: v.error };
    // The cost of an extra claude call such as the judge is added to the sample (otherwise the total and what
    // is persisted under-count it). With no extraCost, the original costUsd is kept, null semantics included.
    const costUsd = v.extraCost != null ? (res.costUsd ?? 0) + v.extraCost : res.costUsd;
    return { ...base, costUsd, schemaValid: true, checks: v.checks, metrics: v.metrics };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function judgeGateA(raw: unknown, fx: Fixture): Judgement {
  const missing = missingRawFields(raw);
  if (missing.length) return { error: `the Gate A output shape has degraded: the raw output is missing the explicit fields [${missing.join(', ')}] (the production schema would fill them in by default, and the eval has to block "a review that scored nothing, with a degraded shape")` };
  const parsed = GateASchema.safeParse(raw);
  if (!parsed.success) return { error: `the output does not match the Gate A contract: ${formatZodError(parsed.error).slice(0, 160)}` };
  const env = parsed.data;
  return { checks: checkGateA(env, fx.expect), metrics: { open_questions: env.open_questions.length, risks: env.risks.length, confidence: env.confidence, prd_score: env.prd_score } };
}

async function judgeGateB(raw: unknown, fx: Fixture): Promise<Judgement> {
  const missing = missingGateBFields(raw);
  if (missing.length) return { error: `the Gate B output shape has degraded: the raw output is missing the explicit fields [${missing.join(', ')}] (the production schema would fill them in by default, and the eval has to block a degraded technical plan or acceptance contract)` };
  const parsed = GateBSchema.safeParse(raw);
  if (!parsed.success) return { error: `the output does not match the Gate B contract: ${formatZodError(parsed.error).slice(0, 160)}` };
  const env = parsed.data;
  const checks = checkGateB(env, fx.expect);
  const metrics: Record<string, number> = { issue_specs: env.issue_specs.length, acceptance_contracts: env.acceptance.contracts.length, acceptance_scenarios: env.acceptance.scenarios.length, confidence: env.confidence };
  // The optional LLM judge on the acceptance's semantic quality (it only runs when acceptance_judge is set,
  // since it is another claude call). A failed judge becomes one failing check rather than aborting the round.
  let extraCost: number | null | undefined;
  if (fx.expect.acceptance_judge) {
    const jr = await judgeAcceptance(fx.inputText, acceptanceMarkdown(env.acceptance));
    extraCost = jr.costUsd; // whether the judge passed, called it weak, or failed, the call already cost money, so it is added to the sample's cost
    if (!jr.ok) {
      checks.push({ name: 'acceptance LLM-judge', pass: false, detail: jr.error });
    } else {
      const { checks: jc, metrics: jm } = acceptanceJudgeChecks(jr.judge, fx.expect.acceptance_judge);
      checks.push(...jc);
      Object.assign(metrics, jm);
    }
  }
  return { checks, metrics, extraCost };
}

// Run one fixture (choosing the Gate A or Gate B judgement by its gate). The cwd is an empty temporary
// directory, so with no project code around it produces from the text alone and is reproducible.
export const evalGateA = (fx: Fixture): Promise<FixtureResult> => evalOnce(fx, buildGateAEvalPrompt, `eval:${fx.name}`, judgeGateA);
export const evalGateB = (fx: Fixture): Promise<FixtureResult> => evalOnce(fx, buildGateBEvalPrompt, `evalB:${fx.name}`, judgeGateB);

// The eval entry point: load the fixtures -> run each of them `runs` times in sequence (avoiding a burst of
// concurrent calls hitting the rate limit, and keeping the cost predictable) -> aggregate into a report.
// runs > 1: run each case several times to see the LLM's jitter; every run must pass (a golden case should
// be stable).
export async function runEval(opts: { only?: string; runs?: number } = {}): Promise<EvalReport> {
  const runs = Math.max(1, opts.runs ?? 1);
  const fixtures = loadFixtures(undefined, opts.only);
  const aggs: AggregatedFixture[] = [];
  for (const fx of fixtures) {
    const evalFn = fx.gate === 'b' ? evalGateB : evalGateA;
    const samples: FixtureResult[] = [];
    for (let i = 0; i < runs; i++) samples.push(await evalFn(fx));
    aggs.push(aggregateFixture(fx.name, fx.expect.desc, samples));
  }
  return summarize(aggs, runs);
}
