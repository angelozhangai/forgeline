// golden eval 的**花钱**部分：用 fixture PRD 真跑闸A 提示词（真 claude），解析产出、对照期望。
// ⚠️ 调真实 claude（花钱）——**不进 npm run ci**，只由手动 `forge eval` 触发。
//
// 设计：复用**生产同款** gate-a.md 模板 + output-contract + GateASchema（正是要保护的资产），
// 只把代码真源换成合成块 + cwd 用中性临时目录 → 隔离、可复现、零副作用（不写库/不发飞书/不动 git）。
// 评的是「提示词/评审方法在给定 PRD 上的产出形状」，刻意不接活代码真源（那是另一层，留作后续扩展）。
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

// 代码真源占位（eval 隔离模式）——明确告诉模型本轮不抓代码、仅凭 PRD/真源文本产出。
const EVAL_FRESHNESS =
  '(eval offline mode: code source-of-truth fetching is skipped this round — produce from the text alone. This eval protects the output shape of the gate prompts/review method; it does not represent production code alignment.)';

// 构造与生产 runGateA **同款**的闸A提示词，仅替换代码真源块 + slug（用 fixture 名）。
export function buildGateAEvalPrompt(name: string, prdText: string): string {
  const proj = project();
  return render(loadPrompt('gate-a.md', proj.id), {
    REPO_FRESHNESS: EVAL_FRESHNESS,
    SLUG: name,
    PRD_TEXT: prdText,
    OUTPUT_CONTRACT: render(loadPrompt('partials/output-contract.md', proj.id), { SIZE_RUBRIC, SCORE_RUBRIC }),
  });
}

// 构造与生产 runGateB **同款**的闸B提示词，输入用 fixture 的 prd-truth.md。
export function buildGateBEvalPrompt(name: string, prdTruth: string): string {
  const proj = project();
  return render(loadPrompt('gate-b.md', proj.id), { REPO_FRESHNESS: EVAL_FRESHNESS, SLUG: name, PRD_TRUTH: prdTruth });
}

// 一次评判：形状达标 → 逐条 check + 关键指标（+ judge 等额外 claude 的 extraCost）；否则给出退化原因。
type Judgement = { error: string } | { checks: CheckResult[]; metrics: Record<string, number>; extraCost?: number | null };

// 通用 eval 骨架：中性临时 cwd（隔离可复现、零副作用）→ 真 claude → 抽原始 JSON → 交 judge 判（可异步，闸B 的 LLM-judge 要）。
async function evalOnce(fx: Fixture, buildPrompt: (name: string, input: string) => string, label: string, judge: (raw: unknown, fx: Fixture) => Judgement | Promise<Judgement>): Promise<FixtureResult> {
  const tmp = mkdtempSync(join(tmpdir(), 'forge-eval-'));
  try {
    const res = await runClaude(buildPrompt(fx.name, fx.inputText), { label, cwd: tmp });
    const base = { name: fx.name, desc: fx.expect.desc, checks: [] as CheckResult[], costUsd: res.costUsd };
    if (!res.ok) return { ...base, schemaValid: false, error: `claude 调用失败：${res.error ?? '未知'}` };
    let raw: unknown;
    try {
      raw = extractJsonBlock(res.result); // zod 注入默认值之前抽原始 JSON，供形状合约查显式字段
    } catch (e) {
      return { ...base, schemaValid: false, error: `产出无可解析 JSON：${String(e).slice(0, 120)}` };
    }
    const v = await judge(raw, fx);
    if ('error' in v) return { ...base, schemaValid: false, error: v.error };
    // judge 等额外 claude 的成本累加进 sample（否则总成本/落盘少算）。无 extraCost 时保留原 costUsd（含 null 语义）。
    const costUsd = v.extraCost != null ? (res.costUsd ?? 0) + v.extraCost : res.costUsd;
    return { ...base, costUsd, schemaValid: true, checks: v.checks, metrics: v.metrics };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function judgeGateA(raw: unknown, fx: Fixture): Judgement {
  const missing = missingRawFields(raw);
  if (missing.length) return { error: `闸A产出形状退化：原始输出缺显式字段 [${missing.join(', ')}]（生产 schema 会默认补全，eval 须挡住「没打分/形状退化的评审」）` };
  const parsed = GateASchema.safeParse(raw);
  if (!parsed.success) return { error: `产出不符合闸A合约：${formatZodError(parsed.error).slice(0, 160)}` };
  const env = parsed.data;
  return { checks: checkGateA(env, fx.expect), metrics: { open_questions: env.open_questions.length, risks: env.risks.length, confidence: env.confidence, prd_score: env.prd_score } };
}

async function judgeGateB(raw: unknown, fx: Fixture): Promise<Judgement> {
  const missing = missingGateBFields(raw);
  if (missing.length) return { error: `闸B产出形状退化：原始输出缺显式字段 [${missing.join(', ')}]（生产 schema 会默认补全，eval 须挡住技术方案/验收契约退化）` };
  const parsed = GateBSchema.safeParse(raw);
  if (!parsed.success) return { error: `产出不符合闸B合约：${formatZodError(parsed.error).slice(0, 160)}` };
  const env = parsed.data;
  const checks = checkGateB(env, fx.expect);
  const metrics: Record<string, number> = { issue_specs: env.issue_specs.length, acceptance_contracts: env.acceptance.contracts.length, acceptance_scenarios: env.acceptance.scenarios.length, confidence: env.confidence };
  // 可选 LLM-judge：评 acceptance 语义质量（设了 acceptance_judge 才跑，多一发 claude）。judge 失败 → 转成一条失败 check，不中断整轮。
  let extraCost: number | null | undefined;
  if (fx.expect.acceptance_judge) {
    const jr = await judgeAcceptance(fx.inputText, acceptanceMarkdown(env.acceptance));
    extraCost = jr.costUsd; // 不管 judge 过/弱/失败，这一发都已花钱，累加进 sample 成本
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

// 跑一个 fixture（按 gate 选闸A/闸B 评判）。cwd 用临时空目录（无项目代码 → 纯凭文本，可复现）。
export const evalGateA = (fx: Fixture): Promise<FixtureResult> => evalOnce(fx, buildGateAEvalPrompt, `eval:${fx.name}`, judgeGateA);
export const evalGateB = (fx: Fixture): Promise<FixtureResult> => evalOnce(fx, buildGateBEvalPrompt, `evalB:${fx.name}`, judgeGateB);

// eval 入口：加载 fixtures → 每条顺序真跑 runs 次（避免并发砸限流、成本可控）→ 聚合报告。
// runs>1：每条跑多次看 LLM 抖动，全过才算过（golden 该稳）。
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
