// PRD 真源（已多轮评审）——闸A 评审封口时机械合成的单一文档，是闸B 技术方案的**唯一需求输入**。
// 设计要点：
// - **机械拼接，不调 claude**：纯字符串合成（PRD 原文 + 闸A 评审定稿 + PM 多轮确认），可复现、可快照测；
//   不引入 Date.now 等非确定量，便于单测与 drift 对账。
// - **封口语义**：在闸A 收口（CONFIRMED）那一刻写盘，冻结「此刻已收敛的需求真源」；闸B 只读这一份。
// - **健壮兜底**：闸B 读时若文档缺（M 强制确认 / 老 session / 被清），即时合成并尽力补写——绝不让闸B 拿空需求。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { projectForSession } from '../projects.ts';
import { GateASchema } from './envelopes.ts';
import type { GateAEnvelope } from './envelopes.ts';
import { sizeBadge } from '../util/sizing.ts';
import type { Session } from '../types.ts';

// 交付目录下的真源文档路径（与 req-review.md / tech-design.md 同处 <deliveryDir>/<slug>/，确定性派生、不入库列）。
export function prdTruthPath(s: Session): string {
  return resolve(projectForSession(s).deliveryDir, s.slug, 'prd-truth.md');
}

// 纯函数合成：PRD 原文 + 闸A 评审定稿 + PM 确认定稿 → 单一 markdown。无 IO、无时间量，便于快照测。
export function buildPrdTruth(prdText: string, env: GateAEnvelope, confirmedNotes: string): string {
  const repos = (env.repos_touched ?? []).join(' / ') || '（未判定）';
  const risks = env.risks.length
    ? env.risks.map((r) => `- [${r.area || '通用'}] ${r.detail}${r.evidence ? `（证据：${r.evidence}）` : ''}`).join('\n')
    : '- （无）';
  // 收口后 open_questions 应为空（已答尽）；若非空（M 强制放行残留）则列出，供闸B 知悉「带问题放行」。
  const oq = env.open_questions.length
    ? env.open_questions.map((q, i) => `${i + 1}. [${q.severity}] ${q.q}${q.suggestion ? `\n   - 倾向：${q.suggestion}` : ''}`).join('\n')
    : '（已全部澄清，PM 答复见「三、PM 确认定稿」）';
  return [
    '# PRD 真源（已多轮评审）',
    '',
    '> Forge 在闸A 评审封口时**机械合成**（非 AI 再创作）：PRD 原文 + claude 评审·codex 对抗复审定稿 + PM 多轮确认。',
    '> 这是闸B 技术方案的**唯一需求输入**——闸B 只读这一份（+ 实时代码真源），不再各自拼三源。',
    '',
    '## 一、PRD 原文',
    '',
    prdText.trim() || '（未提供 PRD 正文）',
    '',
    '## 二、闸A 评审定稿（claude 评审 + codex 对抗复审，已收敛）',
    '',
    `- **概述**：${env.summary || '（无）'}`,
    `- **涉及仓**：${repos}`,
    `- **复杂度**：${sizeBadge(env.size)}${env.size_reason ? `（${env.size_reason}）` : ''}`,
    `- **置信度**：${env.confidence}`,
    '',
    '### 风险 / 冲突',
    risks,
    '',
    '### 开放问题（评审收敛后）',
    oq,
    '',
    '## 三、PM 确认定稿（多轮答复，闸B 据此落方案）',
    '',
    confirmedNotes.trim() || '（无额外备注）',
    '',
  ].join('\n');
}

// 读 session 的闸A 信封。区分两种「缺」，绝不把「坏」静默降级成「空」（守「失败不静默」纪律）：
// - **无 gate_a_output_path**（老 session 从没产出过闸A 信封）→ 空信封兜底（legacy；实质仍由 PRD 原文 + PM 确认承载）。
// - **有路径但读不出/JSON 坏/不合约**（被截断 / 写坏 / 迁移后字段漂移）→ **抛错**，绝不返回标着「已多轮评审」的空壳。
//   抛错经 composePrdTruth → loadPrdTruth → runGateB 冒泡 → worker 停泊 GATE_B_FAILED 等人（解析失败属永久错，不自动重试）。
function readGateAEnv(s: Session): GateAEnvelope {
  if (!s.gate_a_output_path) return GateASchema.parse({}); // legacy：从无闸A 信封
  const p = s.gate_a_output_path;
  let raw: string;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error(`PRD 真源：闸A 信封读不出（${p}）— ${String(e).slice(0, 160)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`PRD 真源：闸A 信封 JSON 解析失败（${p}，疑被截断/写坏）— ${String(e).slice(0, 160)}`);
  }
  try {
    return GateASchema.parse(json);
  } catch (e) {
    throw new Error(`PRD 真源：闸A 信封不合约（${p}，疑迁移后字段漂移）— ${String(e).slice(0, 160)}`);
  }
}

// 从 session 的三源即时合成真源内容（读 PRD 原文 + 闸A 信封 + confirmed_notes）。不写盘。
export function composePrdTruth(s: Session): string {
  const prdText = s.prd_text_path && existsSync(s.prd_text_path) ? readFileSync(s.prd_text_path, 'utf8') : '';
  return buildPrdTruth(prdText, readGateAEnv(s), s.confirmed_notes ?? '');
}

// 封口写盘：仅当 <slug> 交付目录已就绪（闸A 已 scaffold req-review.md）才落盘——与 markReviewActive /
// appendMachineSection 同纪律，避免在未 scaffold（如测试）时凭空在交付目录造文件。返回是否写了。
export function writePrdTruth(s: Session): boolean {
  const p = prdTruthPath(s);
  if (!existsSync(dirname(p))) return false; // 交付目录未就绪 → 不凭空造（闸B loadPrdTruth 会即时合成兜底）
  writeFileSync(p, composePrdTruth(s));
  return true;
}

// 闸B 读取：优先封口文档；缺则即时合成并尽力补写（drift loop 之后也能读到同一份）。始终返回内容。
export function loadPrdTruth(s: Session): string {
  const p = prdTruthPath(s);
  if (existsSync(p)) return readFileSync(p, 'utf8');
  const content = composePrdTruth(s);
  try {
    if (existsSync(dirname(p))) writeFileSync(p, content);
  } catch {
    /* best-effort 补写，失败不挡闸B */
  }
  return content;
}
