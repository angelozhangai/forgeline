// golden eval 的**纯逻辑**：fixture 加载 / 期望解析 / 产出比对 / 报告格式化。
// 不碰 claude、不花钱——故可进 npm run ci（守 harness 本身 + fixtures 不腐）。
// 真正花钱的 claude 调用在 runEval.ts（evalGateA），手动 `forge eval` 才跑。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { GateAEnvelope, GateBEnvelope } from '../gates/envelopes.ts';

// fixtures/eval/<name>/{prd.md, expect.yaml} 的根目录（相对本文件 → 仓库根）。
export const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/eval');

// 一条期望写成「范围/主题命中」而非精确匹配——LLM 非确定，eval 只守「评审方法/产出形状没退化」。
const RangeSchema = z.tuple([z.number(), z.number()]);
export const EvalExpectSchema = z
  .object({
    gate: z.enum(['a', 'b']).default('a'), // a=PRD 评审（输入 prd.md）；b=技术方案（输入 prd-truth.md）
    desc: z.string().default(''),
    // ── 闸A 期望 ──
    open_questions: z
      .object({
        min: z.number().optional(), // 至少问出几个待决项
        max: z.number().optional(), // 至多几个（防过度发问）
        topics: z.array(z.string()).default([]), // 每个主题至少一个 open_question 的 q/suggestion 命中
      })
      .default({}),
    size_in: z.array(z.string()).default([]), // 复杂度档必须落在集合内
    risks_min: z.number().optional(), // 至少识别几条风险
    prd_score_range: RangeSchema.optional(),
    // ── 闸B 期望 ──
    issue_specs_min: z.number().optional(), // 至少切出几个 issue
    issue_repos_include: z.array(z.string()).optional(), // issue 必须覆盖这些仓（C/U/A/E）——防「跨仓需求退化成单仓多 issue」
    acceptance_contracts_min: z.number().optional(), // 验收契约至少几条（drift 对账基准，不能空）
    acceptance_scenarios_min: z.number().optional(), // 验收场景至少几条
    tech_design_min_chars: z.number().optional(), // 技术方案正文至少多长（防空壳）
    multi_repo: z.boolean().optional(), // 是否判为跨仓
    // LLM-judge 评 acceptance **语义质量**（结构 lint 之外，覆盖度/可测性/声明式）。设了才跑（多一发 claude，花钱）。
    acceptance_judge: z
      .object({
        min_coverage: z.number().optional(), // 覆盖 PRD 关键路径 ≥ 分（0-100）
        min_testability: z.number().optional(), // 可测性 ≥ 分（0-100）
        require_declarative: z.boolean().optional(), // 要求声明式（非命令式「点按钮」步骤）
      })
      .strict()
      .optional(),
    // ── 共用 ──
    confidence_range: RangeSchema.optional(),
  })
  .strict();
export type EvalExpect = z.infer<typeof EvalExpectSchema>;

export interface Fixture {
  name: string;
  gate: 'a' | 'b';
  inputText: string; // 闸A=prd.md 原文；闸B=prd-truth.md（PRD 真源）
  expect: EvalExpect;
}

// 加载 fixtures/eval 下所有（或指定 only）golden 用例。输入文件按 gate 取（闸A=prd.md / 闸B=prd-truth.md）。
// expect.yaml 过 zod（坏 fixture 立刻报错，绝不静默）。
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

// ── eval 专属：原始产出形状合约 ──────────────────────────────────────
// 关键：生产 GateASchema 对 size/confidence/prd_score/open_questions… **都有默认值**（生产宽容是对的）。
// 但 eval 当裁判时，若模型退化成 `{}` 或漏掉 prd_score/confidence，zod 会默默补成 size=M/confidence=0/
// prd_score=0/open_questions=[]，宽松的 fixture 仍可能绿——等于给「没打分/形状退化的评审」发绿灯，
// 正好背叛 Phase 6 的目标。故 eval 在**注入默认值之前**先查原始输出必须**显式**带这些维度（证明评审方法没退化）。
// 与 prompts/partials/output-contract.md 顶层字段一一对齐——少一个都视为评审方法退化。
// repos_touched/needs_lead 还喂 triage 升级路由，漏掉会影响把关判断，必须显式产出。
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

// prd_score_dims 的四个子维度——光有顶层对象不够，模型必须真打出四维分（否则等于不打分）。
export const REQUIRED_SCORE_DIMS = ['clarity', 'completeness', 'feasibility', 'testability'] as const;

// 返回原始产出里缺失（不存在 / null）的必备字段。非对象 → 视为全缺。
// prd_score_dims 还要下钻查四个子维度（present 但非对象 / 缺某维 → 点名 `prd_score_dims.<维>`）。
export function missingRawFields(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [...REQUIRED_GATE_A_FIELDS];
  const obj = raw as Record<string, unknown>;
  const missing: string[] = REQUIRED_GATE_A_FIELDS.filter((f) => obj[f] === undefined || obj[f] === null);
  // prd_score_dims 缺/null 已在上面点名顶层；这里只在它「存在」时下钻查四维（含「存在但非对象」的坏形状）。
  const dims = obj.prd_score_dims;
  if (dims !== undefined && dims !== null) {
    if (typeof dims === 'object' && !Array.isArray(dims)) {
      const d = dims as Record<string, unknown>;
      for (const k of REQUIRED_SCORE_DIMS) if (d[k] === undefined || d[k] === null) missing.push(`prd_score_dims.${k}`);
    } else {
      for (const k of REQUIRED_SCORE_DIMS) missing.push(`prd_score_dims.${k}`); // 存在但非对象（如 []）→ 四维都不可能在
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
  return { name: `${label}∈[${lo},${hi}]`, pass: val >= lo && val <= hi, detail: `实际 ${val}` };
}

// 把一份**已解析合约**的闸A产出，对照 fixture 期望逐条判定（纯函数）。schema 合法性由调用方在解析时单独记。
export function checkGateA(env: GateAEnvelope, x: EvalExpect): CheckResult[] {
  const out: CheckResult[] = [];
  const oqs = env.open_questions;
  if (x.open_questions.min != null) out.push({ name: `open_questions≥${x.open_questions.min}`, pass: oqs.length >= x.open_questions.min, detail: `实际 ${oqs.length}` });
  if (x.open_questions.max != null) out.push({ name: `open_questions≤${x.open_questions.max}`, pass: oqs.length <= x.open_questions.max, detail: `实际 ${oqs.length}` });
  for (const topic of x.open_questions.topics) {
    const hit = oqs.some((q) => `${q.q} ${q.suggestion ?? ''}`.includes(topic));
    out.push({ name: `open_question 命中「${topic}」`, pass: hit, detail: hit ? '命中' : '无 open_question 提及' });
  }
  if (x.size_in.length) out.push({ name: `size∈{${x.size_in.join(',')}}`, pass: x.size_in.includes(env.size), detail: `实际 ${env.size}` });
  if (x.risks_min != null) out.push({ name: `risks≥${x.risks_min}`, pass: env.risks.length >= x.risks_min, detail: `实际 ${env.risks.length}` });
  if (x.confidence_range) out.push(rangeCheck('confidence', env.confidence, x.confidence_range));
  if (x.prd_score_range) out.push(rangeCheck('prd_score', env.prd_score, x.prd_score_range));
  return out;
}

// ── 闸B：形状合约 + 期望比对 ──────────────────────────────────────
// 同闸A：生产 GateBSchema 对所有字段都有默认值，eval 当裁判要在注入默认值前查原始输出显式带这些维度。
export const REQUIRED_GATE_B_FIELDS = ['summary', 'key_decisions', 'tech_design_markdown', 'acceptance', 'multi_repo', 'issue_specs', 'confidence'] as const;

// 闸B 原始产出形状缺失字段。acceptance 下钻查 contracts/scenarios（drift 对账基准，不能退化成空壳）。
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

// 把一份**已解析合约**的闸B产出，对照 fixture 期望逐条判定（纯函数）。
export function checkGateB(env: GateBEnvelope, x: EvalExpect): CheckResult[] {
  const out: CheckResult[] = [];
  if (x.issue_specs_min != null) out.push({ name: `issue_specs≥${x.issue_specs_min}`, pass: env.issue_specs.length >= x.issue_specs_min, detail: `实际 ${env.issue_specs.length}` });
  if (x.issue_repos_include?.length) {
    const repos = new Set(env.issue_specs.map((i) => i.repo));
    const miss = x.issue_repos_include.filter((r) => !repos.has(r));
    out.push({ name: `issue 覆盖仓 {${x.issue_repos_include.join(',')}}`, pass: miss.length === 0, detail: miss.length ? `缺 ${miss.join(',')}（实际 ${[...repos].join(',') || '无'}）` : `齐全（${[...repos].join(',')}）` });
  }
  if (x.acceptance_contracts_min != null) out.push({ name: `acceptance.contracts≥${x.acceptance_contracts_min}`, pass: env.acceptance.contracts.length >= x.acceptance_contracts_min, detail: `实际 ${env.acceptance.contracts.length}` });
  if (x.acceptance_scenarios_min != null) out.push({ name: `acceptance.scenarios≥${x.acceptance_scenarios_min}`, pass: env.acceptance.scenarios.length >= x.acceptance_scenarios_min, detail: `实际 ${env.acceptance.scenarios.length}` });
  if (x.tech_design_min_chars != null) out.push({ name: `tech_design≥${x.tech_design_min_chars}字`, pass: env.tech_design_markdown.length >= x.tech_design_min_chars, detail: `实际 ${env.tech_design_markdown.length}` });
  if (x.multi_repo != null) out.push({ name: `multi_repo=${x.multi_repo}`, pass: env.multi_repo === x.multi_repo, detail: `实际 ${env.multi_repo}` });
  if (x.confidence_range) out.push(rangeCheck('confidence', env.confidence, x.confidence_range));
  return out;
}

// 一个 fixture 跑**一次**的结果（schemaValid=false 表示产出连合约都不符——最重的回归）。
// metrics：本次产出的关键数值（open_questions/risks/confidence/prd_score…），供多样本抖动 + 趋势对比用。
export interface FixtureResult {
  name: string;
  desc: string;
  schemaValid: boolean;
  checks: CheckResult[];
  costUsd: number | null;
  error?: string;
  metrics?: Record<string, number>;
}

// 一次跑是否通过：合约合法 + 无错 + 全部 check 过。
export function fixturePassed(r: FixtureResult): boolean {
  return r.schemaValid && !r.error && r.checks.every((c) => c.pass);
}
