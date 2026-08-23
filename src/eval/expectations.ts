// The **pure logic** of the golden eval: loading a fixture, parsing its expectations, comparing the output,
// and formatting the report.
// It never touches claude and never costs money, so it can run under npm run ci (guarding the harness itself
// and keeping the fixtures from rotting).
// The claude calls that do cost money live in runEval.ts (evalGateA) and only run under a manual
// `forge eval`.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { GateAEnvelope, GateBEnvelope } from '../gates/envelopes.ts';

// The root of fixtures/eval/<name>/{prd.md, expect.yaml} (relative to this file, so the repository root).
// FORGE_EVAL_FIXTURES_DIR points at a private golden set outside the repo (real PRDs do not belong in a
// public repo).
//
// Unlike config's per-file fallback, this is a **wholesale replacement**: the point of an eval report is
// "the review method has not regressed on this set of samples", and mixing private samples with the repo's
// demo samples produces a pass rate that means nothing.
// An empty or whitespace-only value counts as unset, for the same reason as envDir in src/root.ts.
const evalOverride = process.env.FORGE_EVAL_FIXTURES_DIR?.trim();
export const EVAL_ROOT = evalOverride
  ? resolve(evalOverride)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/eval');

// An expectation is written as a range or a topic hit rather than an exact match — an LLM is not
// deterministic, and the eval only guards that the review method and the output shape have not regressed.
const RangeSchema = z.tuple([z.number(), z.number()]);
export const EvalExpectSchema = z
  .object({
    gate: z.enum(['a', 'b']).default('a'), // a = PRD review (input prd.md); b = technical plan (input prd-truth.md)
    desc: z.string().default(''),
    // ── Gate A expectations ──
    open_questions: z
      .object({
        min: z.number().optional(), // at least this many open questions raised
        max: z.number().optional(), // at most this many (guarding against over-questioning)
        topics: z.array(z.string()).default([]), // each topic must be hit by the q or suggestion of at least one open_question
      })
      .default({}),
    size_in: z.array(z.string()).default([]), // the complexity tier must fall in this set
    risks_min: z.number().optional(), // at least this many risks identified
    prd_score_range: RangeSchema.optional(),
    // ── Gate B expectations ──
    issue_specs_min: z.number().optional(), // at least this many issues carved out
    issue_repos_include: z.array(z.string()).optional(), // the issues must cover these repos (C/U/A/E) — guarding against "a cross-repo requirement degrading into several issues in one repo"
    acceptance_contracts_min: z.number().optional(), // at least this many acceptance contracts (the baseline for drift reconciliation, which must not be empty)
    acceptance_scenarios_min: z.number().optional(), // at least this many acceptance scenarios
    tech_design_min_chars: z.number().optional(), // the technical plan must be at least this long (guarding against an empty shell)
    multi_repo: z.boolean().optional(), // whether it is judged cross-repo
    // An LLM judge on the **semantic quality** of the acceptance (beyond the structural lint: coverage,
    // testability, whether it is declarative). It only runs when set, since it is another claude call and
    // costs money.
    acceptance_judge: z
      .object({
        min_coverage: z.number().optional(), // covers the PRD's critical paths at or above this score (0-100)
        min_testability: z.number().optional(), // testability at or above this score (0-100)
        require_declarative: z.boolean().optional(), // require it to be declarative (not imperative click-a-button steps)
      })
      .strict()
      .optional(),
    // ── Shared ──
    confidence_range: RangeSchema.optional(),
  })
  .strict();
export type EvalExpect = z.infer<typeof EvalExpectSchema>;

export interface Fixture {
  name: string;
  gate: 'a' | 'b';
  inputText: string; // Gate A = the text of prd.md; Gate B = prd-truth.md (the PRD source of truth)
  expect: EvalExpect;
}

// Load every golden case under fixtures/eval (or just the one named by `only`). The input file is chosen by
// gate (Gate A = prd.md, Gate B = prd-truth.md).
// expect.yaml goes through zod, so a broken fixture errors immediately rather than passing silently.
export function loadFixtures(root: string = EVAL_ROOT, only?: string): Fixture[] {
  if (!existsSync(root)) return [];
  const names = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => !only || n === only)
    .sort();
  return names.map((name) => {
    const dir = resolve(root, name);
    const expect = EvalExpectSchema.parse(parseYaml(readFileSync(resolve(dir, 'expect.yaml'), 'utf8')));
    const inputFile = expect.gate === 'b' ? 'prd-truth.md' : 'prd.md';
    const inputText = readFileSync(resolve(dir, inputFile), 'utf8');
    return { name, gate: expect.gate, inputText, expect };
  });
}

// ── Eval-only: the contract on the raw output shape ──────────────────────────────────────
// The key point: the production GateASchema has **defaults for everything** — size, confidence, prd_score,
// open_questions and the rest — and being forgiving in production is right.
// But when the eval is acting as judge, a model that degrades to `{}` or drops prd_score/confidence would
// have zod quietly fill in size=M / confidence=0 / prd_score=0 / open_questions=[], and a loose fixture could
// still come out green — which is a green light for "a review that scored nothing, with a degraded shape",
// exactly betraying the goal of phase 6. So the eval checks the raw output for these dimensions **before**
// the defaults are injected, proving the review method has not regressed.
// It lines up one-for-one with the top-level fields of prompts/partials/output-contract.md — one missing
// field counts as the review method regressing.
// repos_touched and needs_lead also feed the triage escalation routing, so dropping them affects the
// gatekeeping judgement; they must be produced explicitly.
export const REQUIRED_GATE_A_FIELDS = [
  'summary',
  'repos_touched',
  'size',
  'size_reason',
  'open_questions',
  'risks',
  'confidence',
  'needs_lead',
  'prd_score',
  'prd_score_dims',
  'prd_score_reason',
] as const;

// The four sub-dimensions of prd_score_dims — the top-level object alone is not enough, the model has to
// actually score all four (otherwise it amounts to not scoring at all).
export const REQUIRED_SCORE_DIMS = ['clarity', 'completeness', 'feasibility', 'testability'] as const;

// The required fields missing (absent or null) from the raw output. A non-object counts as all of them
// missing.
// prd_score_dims is drilled into for its four sub-dimensions as well (present but not an object, or a
// dimension missing, is named as `prd_score_dims.<dimension>`).
export function missingRawFields(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [...REQUIRED_GATE_A_FIELDS];
  const obj = raw as Record<string, unknown>;
  const missing: string[] = REQUIRED_GATE_A_FIELDS.filter((f) => obj[f] === undefined || obj[f] === null);
  // prd_score_dims being missing or null is already named at the top level above; this only drills into the
  // four dimensions when it is present (including the broken shape of "present but not an object").
  const dims = obj.prd_score_dims;
  if (dims !== undefined && dims !== null) {
    if (typeof dims === 'object' && !Array.isArray(dims)) {
      const d = dims as Record<string, unknown>;
      for (const k of REQUIRED_SCORE_DIMS) if (d[k] === undefined || d[k] === null) missing.push(`prd_score_dims.${k}`);
    } else {
      for (const k of REQUIRED_SCORE_DIMS) missing.push(`prd_score_dims.${k}`); // present but not an object (an [], say) -> none of the four can be there
    }
  }
  return missing;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

function rangeCheck(label: string, val: number, [lo, hi]: [number, number]): CheckResult {
  return { name: `${label} in [${lo},${hi}]`, pass: val >= lo && val <= hi, detail: `actual ${val}` };
}

// Judge one **already contract-parsed** Gate A output against a fixture's expectations, check by check (a
// pure function). Schema validity is recorded separately by the caller at parse time.
export function checkGateA(env: GateAEnvelope, x: EvalExpect): CheckResult[] {
  const out: CheckResult[] = [];
  const oqs = env.open_questions;
  if (x.open_questions.min != null) out.push({ name: `open_questions >= ${x.open_questions.min}`, pass: oqs.length >= x.open_questions.min, detail: `actual ${oqs.length}` });
  if (x.open_questions.max != null) out.push({ name: `open_questions <= ${x.open_questions.max}`, pass: oqs.length <= x.open_questions.max, detail: `actual ${oqs.length}` });
  for (const topic of x.open_questions.topics) {
    const hit = oqs.some((q) => `${q.q} ${q.suggestion ?? ''}`.includes(topic));
    out.push({ name: `an open_question mentions "${topic}"`, pass: hit, detail: hit ? 'hit' : 'no open_question mentions it' });
  }
  if (x.size_in.length) out.push({ name: `size in {${x.size_in.join(',')}}`, pass: x.size_in.includes(env.size), detail: `actual ${env.size}` });
  if (x.risks_min != null) out.push({ name: `risks >= ${x.risks_min}`, pass: env.risks.length >= x.risks_min, detail: `actual ${env.risks.length}` });
  if (x.confidence_range) out.push(rangeCheck('confidence', env.confidence, x.confidence_range));
  if (x.prd_score_range) out.push(rangeCheck('prd_score', env.prd_score, x.prd_score_range));
  return out;
}

// ── Gate B: the shape contract plus the expectation comparison ──────────────────────────────────────
// Same as Gate A: the production GateBSchema defaults every field, so the eval acting as judge has to check
// the raw output for these dimensions before the defaults are injected.
export const REQUIRED_GATE_B_FIELDS = ['summary', 'key_decisions', 'tech_design_markdown', 'acceptance', 'multi_repo', 'issue_specs', 'confidence'] as const;

// The fields missing from a raw Gate B output. acceptance is drilled into for contracts and scenarios (the
// baseline for drift reconciliation, which must not degrade into an empty shell).
export function missingGateBFields(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [...REQUIRED_GATE_B_FIELDS];
  const obj = raw as Record<string, unknown>;
  const missing: string[] = REQUIRED_GATE_B_FIELDS.filter((f) => obj[f] === undefined || obj[f] === null);
  const acc = obj.acceptance;
  if (acc !== undefined && acc !== null) {
    if (typeof acc === 'object' && !Array.isArray(acc)) {
      const a = acc as Record<string, unknown>;
      for (const k of ['contracts', 'scenarios'] as const) if (a[k] === undefined || a[k] === null) missing.push(`acceptance.${k}`);
    } else {
      for (const k of ['contracts', 'scenarios'] as const) missing.push(`acceptance.${k}`);
    }
  }
  return missing;
}

// Judge one **already contract-parsed** Gate B output against a fixture's expectations, check by check (a
// pure function).
export function checkGateB(env: GateBEnvelope, x: EvalExpect): CheckResult[] {
  const out: CheckResult[] = [];
  if (x.issue_specs_min != null) out.push({ name: `issue_specs >= ${x.issue_specs_min}`, pass: env.issue_specs.length >= x.issue_specs_min, detail: `actual ${env.issue_specs.length}` });
  if (x.issue_repos_include?.length) {
    const repos = new Set(env.issue_specs.map((i) => i.repo));
    const miss = x.issue_repos_include.filter((r) => !repos.has(r));
    out.push({ name: `the issues cover the repos {${x.issue_repos_include.join(',')}}`, pass: miss.length === 0, detail: miss.length ? `missing ${miss.join(',')} (actual ${[...repos].join(',') || 'none'})` : `all present (${[...repos].join(',')})` });
  }
  if (x.acceptance_contracts_min != null) out.push({ name: `acceptance.contracts >= ${x.acceptance_contracts_min}`, pass: env.acceptance.contracts.length >= x.acceptance_contracts_min, detail: `actual ${env.acceptance.contracts.length}` });
  if (x.acceptance_scenarios_min != null) out.push({ name: `acceptance.scenarios >= ${x.acceptance_scenarios_min}`, pass: env.acceptance.scenarios.length >= x.acceptance_scenarios_min, detail: `actual ${env.acceptance.scenarios.length}` });
  if (x.tech_design_min_chars != null) out.push({ name: `tech_design >= ${x.tech_design_min_chars} chars`, pass: env.tech_design_markdown.length >= x.tech_design_min_chars, detail: `actual ${env.tech_design_markdown.length}` });
  if (x.multi_repo != null) out.push({ name: `multi_repo=${x.multi_repo}`, pass: env.multi_repo === x.multi_repo, detail: `actual ${env.multi_repo}` });
  if (x.confidence_range) out.push(rangeCheck('confidence', env.confidence, x.confidence_range));
  return out;
}

// The result of **one** run of a fixture (schemaValid=false means the output did not even match the
// contract — the heaviest regression).
// metrics: the key numbers from this output (open_questions / risks / confidence / prd_score …), used for
// multi-sample jitter and trend comparison.
export interface FixtureResult {
  name: string;
  desc: string;
  schemaValid: boolean;
  checks: CheckResult[];
  costUsd: number | null;
  error?: string;
  metrics?: Record<string, number>;
}

// Whether one run passed: the contract is valid, there was no error, and every check passed.
export function fixturePassed(r: FixtureResult): boolean {
  return r.schemaValid && !r.error && r.checks.every((c) => c.pass);
}
