// Session 上 JSON 文本列的「读模型」解析：把 routing / 残留 / 评分维度等 TEXT 列解成结构。
// 单一真源——之前散在 notify.ts（私有）与 index.ts（内联）各解一份。坏/缺 JSON 一律返回空骨架/null
// （展示层尽力而为，不抛——真源失败的停泊在写入侧已落实「失败不静默」，这里只是渲染读取）。
import type { Session, Routing } from '../types.ts';
import type { ScoreDims } from '../util/scoring.ts';

export function routingOf(s: Session): Routing | null {
  try {
    return s.routing ? (JSON.parse(s.routing) as Routing) : null;
  } catch {
    return null;
  }
}

// PRD 评分四维（清晰/完整/可行/可测，各 0-25）。坏/缺 → null（徽章降级）。
export function parseDims(json: string | null): ScoreDims | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ScoreDims;
  } catch {
    return null;
  }
}

// 一条残留 finding（对抗复审/闸B 未消解意见）。evidence 仅 CLI 详情展示，卡片侧不读（多带无害）。
export interface ResidualFinding {
  severity?: string;
  issue: string;
  where?: string;
  fix?: string;
  evidence?: string;
}

// 闸A 残留（gate_a_residual）：PM 多轮开放问题 或 codex 对抗未消解 findings（source 区分）。
export interface ResidualRead {
  round: number;
  source?: string; // 'codex'=对抗复审未消解的 findings；缺省=PM 多轮开放问题
  open_questions: { q: string; suggestion?: string; severity?: string }[];
  findings: ResidualFinding[];
}
export function readResidual(json: string | null): ResidualRead {
  const empty: ResidualRead = { round: 0, open_questions: [], findings: [] };
  if (!json) return empty;
  try {
    const j = JSON.parse(json) as Partial<ResidualRead>;
    return {
      round: j.round ?? 0,
      source: j.source,
      open_questions: Array.isArray(j.open_questions) ? j.open_questions : [],
      findings: Array.isArray(j.findings) ? j.findings : [],
    };
  } catch {
    return empty;
  }
}

// 闸B 对抗残留（adversarial_residual）：到上限仍未消解的 findings + 轮次 + 用了哪个 reviewer。
export interface GateBResidualRead {
  round: number;
  used: string;
  findings: ResidualFinding[];
}
export function readGateBResidual(json: string | null): GateBResidualRead {
  const empty: GateBResidualRead = { round: 0, used: '', findings: [] };
  if (!json) return empty;
  try {
    const j = JSON.parse(json) as Partial<GateBResidualRead>;
    return { round: j.round ?? 0, used: j.used ?? '', findings: Array.isArray(j.findings) ? j.findings : [] };
  } catch {
    return empty;
  }
}

// 对抗残留里待裁决意见条数（GO 卡 / CLI 显「N 条待裁决」）。坏/缺 → 0。
export function residualCount(json: string | null): number {
  return readGateBResidual(json).findings.length;
}
