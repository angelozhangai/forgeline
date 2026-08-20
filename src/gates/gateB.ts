import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectForSession } from '../projects.ts';
import { randomUUID } from 'node:crypto';
import { loadPrompt, render, sessionLogDir } from '../util/render.ts';
import { parseStructured, strictParse } from '../llm/structured.ts';
import { runClaude } from '../llm/runClaude.ts';
import { refresh, assertFresh } from './repoFreshness.ts';
import { anchorCheck } from './repoAnchor.ts';
import { loadPrdTruth } from './prdTruth.ts';
import { GateBSchema, GATE_B_CONTRACT } from './envelopes.ts';
import type { GateBEnvelope, Verdict } from './envelopes.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { store } from '../store/index.ts';
const { patch, appendEvent } = store; // 经 SessionStore 接缝取本地实现方法（自由函数无 this，解构安全）
import { projectActions } from '../project/index.ts';
import { acceptanceMarkdown } from '../util/acceptance.ts';
import type { Session } from '../types.ts';

export function gateBPaths(id: string): { draft: string; issues: string } {
  const dir = sessionLogDir(id);
  return { draft: resolve(dir, 'gate-b.json'), issues: resolve(dir, 'issues.json') };
}

export async function persistGateB(s: Session, env: GateBEnvelope): Promise<void> {
  const { draft, issues } = gateBPaths(s.id);
  writeFileSync(draft, JSON.stringify(env, null, 2));
  writeFileSync(issues, JSON.stringify(env.issue_specs, null, 2));
  await patch(s.id, { gate_b_draft_path: draft, issue_specs_path: issues });
}

function appendTechDesignMachine(deliveryDir: string, slug: string, env: GateBEnvelope): void {
  const doc = resolve(deliveryDir, slug, 'tech-design.md');
  if (!existsSync(doc)) return;
  const kd = Object.entries(env.key_decisions ?? {})
    .map(([k, v]) => `- **${k}**：${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
  const acc = acceptanceMarkdown(env.acceptance);
  const block =
    `\n\n---\n\n## 🤖 机器技术方案（codex审⇄claude改 定稿 · 待人工核对 / 精简）\n` +
    `> \`claude -p\` 生成 + Codex 多轮对抗复审后定稿。人核对后据此放行；不替代上方「⚡ 关键决策」（请把要点搬上去）。\n\n` +
    `### 关键决策（机器版）\n${kd || '（无）'}\n\n` +
    `### 验收契约（外环 · 当前应全红）\n${acc || '（无）'}\n\n` +
    `### 方案正文\n${env.tech_design_markdown || '（无）'}\n`;
  appendFileSync(doc, block);
}

// 对抗到上限仍未消解的意见，追加进 tech-design.md（人 GO 前 review 的就是这份文档）。
export function appendResidualToDoc(
  deliveryDir: string,
  slug: string,
  r: { round: number; used: string; findings: Verdict['findings'] },
): void {
  const doc = resolve(deliveryDir, slug, 'tech-design.md');
  if (!existsSync(doc)) return;
  const items = r.findings
    .map(
      (f, i) =>
        `${i + 1}. **[${f.severity}]** ${f.issue}${f.where ? `（位置：${f.where}）` : ''}\n` +
        `   - 建议：${f.fix || '（无）'}${f.evidence ? `\n   - 证据：${f.evidence}` : ''}`,
    )
    .join('\n');
  const block =
    `\n\n---\n\n## ⚖️ 对抗复审未裁决意见（需人工裁决）\n` +
    `> Codex/claude 对抗复审到达上限第 ${r.round} 轮（reviewer=${r.used}），下列 ${r.findings.length} 条意见仍未被方案消解。` +
    `**放行（GO）前须人工逐条裁决**：采纳则改方案、驳回则记理由。\n\n${items}\n`;
  appendFileSync(doc, block);
}

// 闸B 循环终结后把「定稿方案 + （若有）未裁决残留」一次性落进 tech-design.md（人 GO 前 review 的文档）。
// 放到循环结束才落，避免每轮 append 出多份草稿；草稿 JSON（gate-b.json）则每轮就地更新。
export function finalizeGateBDoc(s: Session): void {
  const { draft } = gateBPaths(s.id);
  if (!existsSync(draft)) return;
  let env: GateBEnvelope;
  try {
    env = GateBSchema.parse(JSON.parse(readFileSync(draft, 'utf8')));
  } catch {
    return;
  }
  const deliveryDir = projectForSession(s).deliveryDir;
  appendTechDesignMachine(deliveryDir, s.slug, env);
  if (s.adversarial_residual) {
    try {
      const r = JSON.parse(s.adversarial_residual) as { round: number; used: string; findings: Verdict['findings'] };
      appendResidualToDoc(deliveryDir, s.slug, r);
    } catch {
      /* ignore */
    }
  }
}

// 执行闸B 一步：分析 → 解析 → scaffold 技术方案文档 + 落 issue 草案。失败抛错。
export async function runGateB(s: Session): Promise<GateBEnvelope> {
  const proj = projectForSession(s);
  // 单一需求输入：闸A 封口时机械合成的 PRD 真源（原文 + 评审定稿 + PM 确认）。缺则即时合成兜底（见 prdTruth.ts）。
  const prdTruth = loadPrdTruth(s);
  const fresh = await refresh(s.branch, proj);
  assertFresh(fresh); // 闸B 同样对照重新 fetch 的代码真源 → 取不到则停泊，绝不静默降级
  // checkout 锚定校验：claude 读活 checkout，不在锚定 sha / 脏树 → 披露给模型（warn）或停泊（block）。
  const { off, disclosure } = anchorCheck(proj, fresh, loadConfig().runtime.gates?.checkout_anchor ?? 'warn');
  if (off.length) {
    log.warn(`闸B：${off.join(', ')} checkout 未锚定 origin/${s.branch}（已在 prompt 披露，继续出方案）`);
    await appendEvent(s.id, 'checkout_off_anchor', { gate: 'B', off, branch: s.branch });
  }
  const freshnessBlock = render(loadPrompt('partials/repo-freshness.md', proj.id), {
    FETCHED_AT: fresh.fetchedAt,
    REPO_REFS: fresh.refsText + disclosure,
  });
  const prompt = render(loadPrompt('gate-b.md', proj.id), {
    REPO_FRESHNESS: freshnessBlock,
    SLUG: s.slug,
    PRD_TRUTH: prdTruth,
  });

  const dir = sessionLogDir(s.id);
  writeFileSync(resolve(dir, 'gate-b.prompt.txt'), prompt);
  const sid = randomUUID(); // pin 会话号：解析失败时 resume 同会话回喂重出（仅本次调用内用）
  const res = await runClaude(prompt, { label: '闸B', sessionId: sid, cwd: proj.root });
  writeFileSync(resolve(dir, 'gate-b.raw.txt'), res.raw ?? '');
  if (!res.ok) throw new Error(`闸B claude 失败：${res.error}`);

  let env: GateBEnvelope;
  try {
    env = await parseStructured<GateBEnvelope>({
      text: res.result,
      parse: (t) => strictParse(GateBSchema, t),
      reEmit: async (instruction) => {
        const r = await runClaude(instruction, { label: '闸B·修复输出', resume: sid, cwd: proj.root });
        return r.ok ? r.result : null;
      },
      buildRepairInstruction: (error) =>
        render(loadPrompt('partials/parse-repair.md', proj.id), { ERROR: error, CONTRACT: GATE_B_CONTRACT }),
      maxRetries: loadConfig().runtime.parse_repair_retries ?? 2,
      note: (kind, detail) => appendEvent(s.id, `gateb_${kind}`, detail),
      dump: (raw) => {
        try { writeFileSync(resolve(dir, 'gate-b.result.txt'), raw); } catch { /* 落盘失败不阻断 */ }
      },
    });
  } catch (e) {
    writeFileSync(resolve(dir, 'gate-b.result.txt'), res.result);
    throw new Error(`闸B 输出解析失败（自愈重试仍失败）：${String(e).slice(0, 200)}（见 logs/${s.id}/gate-b.result.txt）`);
  }

  await patch(s.id, {
    repo_shas_b: JSON.stringify(fresh.shas),
    gate_b_cost_usd: res.costUsd,
  });
  await persistGateB(s, env);

  await projectActions(proj).scaffoldTechDesign({
    slug: s.slug,
    prd: s.prd_url,
    owner: env.issue_specs[0]?.assignee ?? undefined, // 注：scaffold 的 --owner = 文档负责人(assignee login)，非 GitHub org
    title: s.title,
    force: true,
  });
  // 注：机器方案正文不在此 append——由 finalizeGateBDoc 在 codex审⇄claude改 循环定稿后一次性落盘（避免每轮多份草稿）。
  return env;
}
