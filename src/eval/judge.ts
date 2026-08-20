// acceptance 语义守护（#3）：结构 lint（有 contracts+scenarios）之外，用 LLM-judge 评**语义质量**——
// 验收是否真覆盖 PRD 关键路径、是否可测（声明式 Given/When/Then + 断言，而非命令式「点按钮」步骤）。
// acceptance 是漂移闭环的对账基准：基准本身写得烂，drift 对账再准也白搭。
//
// judge 本身花钱（多一发 claude）→ 只在 gate:b fixture 显式 `acceptance_judge` 时跑、只在 `forge eval` 里。
// 结果→check 的转换（acceptanceJudgeChecks）与解析（parseAcceptanceJudge）是纯逻辑，进 ci。
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
    coverage: z.number().default(0), // 0-100：验收覆盖 PRD 关键路径的程度
    testability: z.number().default(0), // 0-100：可测性（声明式 + 有断言 + 契约具体）
    declarative: z.boolean().default(false), // 是否声明式（Given/When/Then 描述结果，而非命令式操作步骤）
    issues: z.array(z.string()).default([]), // 具体问题（覆盖缺口 / 命令式步骤 / 契约含糊…）
    verdict: z.enum(['good', 'weak']).default('weak'),
  })
  .strict();
export type AcceptanceJudge = z.infer<typeof AcceptanceJudgeSchema>;

export type JudgeExpect = NonNullable<EvalExpect['acceptance_judge']>;

// 纯：judge 结果 + 门槛 → 逐条 check + 指标。供 evalGateB 在结构 check 之上追加。
export function acceptanceJudgeChecks(j: AcceptanceJudge, x: JudgeExpect): { checks: CheckResult[]; metrics: Record<string, number> } {
  const checks: CheckResult[] = [];
  if (x.min_coverage != null) checks.push({ name: `acceptance 覆盖≥${x.min_coverage}`, pass: j.coverage >= x.min_coverage, detail: `judge 给 ${j.coverage}${j.issues.length ? `；问题：${j.issues.slice(0, 2).join('；')}` : ''}` });
  if (x.min_testability != null) checks.push({ name: `acceptance 可测性≥${x.min_testability}`, pass: j.testability >= x.min_testability, detail: `judge 给 ${j.testability}` });
  if (x.require_declarative) checks.push({ name: 'acceptance 声明式（非命令式步骤）', pass: j.declarative, detail: j.declarative ? '是' : '判为命令式/操作步骤' });
  return { checks, metrics: { acceptance_coverage: j.coverage, acceptance_testability: j.testability } };
}

// 花钱：渲染 judge 提示词 → 真 claude（中性临时 cwd）→ 解析。返回 ok/err（不抛——交调用方转成失败 check，不中断整轮）。
// **始终回传 costUsd**（即便解析失败 / claude 报错也已花钱）——调用方累加进 sample 成本，避免总成本/落盘少算 judge 这一发。
export async function judgeAcceptance(prdTruth: string, acceptanceMd: string): Promise<({ ok: true; judge: AcceptanceJudge } | { ok: false; error: string }) & { costUsd: number | null }> {
  const proj = project();
  const prompt = render(loadPrompt('eval/acceptance-judge.md', proj.id), { PRD_TRUTH: prdTruth, ACCEPTANCE: acceptanceMd });
  const tmp = mkdtempSync(join(tmpdir(), 'forge-judge-'));
  try {
    const res = await runClaude(prompt, { label: 'eval-judge:acceptance', cwd: tmp });
    if (!res.ok) return { ok: false, error: `judge claude 调用失败：${res.error ?? '未知'}`, costUsd: res.costUsd };
    try {
      return { ok: true, judge: strictParse(AcceptanceJudgeSchema, res.result), costUsd: res.costUsd };
    } catch (e) {
      return { ok: false, error: `judge 产出不符合契约：${String(e).slice(0, 140)}`, costUsd: res.costUsd };
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
