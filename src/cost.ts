// 成本看板（私有·管理面）：聚合每条需求的闸A/闸B/闸C/闸D claude 改方美元成本（codex --json 无美元口径，
// 故只计 claude，与 show 的 cost 口径一致）。纯函数——CLI 先按需过滤再喂入，便于单测。
// ⚠️ 与 PRD 评分/人均负载同属管理面：只在本服务内可见，绝不写进交付文档/飞书/issue。
import type { Session } from './types.ts';

export interface CostRow {
  ref: string; // REQ-N（无则 id 前 8）
  slug: string;
  state: string;
  size: string | null;
  gateA: number; // 闸A 评审 + 对抗改方累计 $
  gateB: number; // 闸B 改方累计 $
  gateC: number; // 闸C 实现⇄CI 累计 $（下游，重头）
  gateD: number; // 闸D PR审改 + 补强累计 $（下游，重头）
  total: number;
  assignee: string | null;
  updatedAt: number;
}

export interface CostSummary {
  total: number; // 全部需求总花费 $
  gateA: number;
  gateB: number;
  gateC: number;
  gateD: number;
  count: number; // 纳入统计的需求数
  withCost: number; // 其中真正产生过成本的数量
  byState: { state: string; count: number; usd: number }[]; // 按状态分桶（花费降序）
}

export function costRows(rows: Session[]): CostRow[] {
  return rows.map((s) => {
    const gateA = s.gate_a_cost_usd ?? 0;
    const gateB = s.gate_b_cost_usd ?? 0;
    const gateC = s.gate_c_cost_usd ?? 0;
    const gateD = s.gate_d_cost_usd ?? 0;
    return {
      ref: s.ref_num != null ? `REQ-${s.ref_num}` : s.id.slice(0, 8),
      slug: s.slug,
      state: s.state,
      size: s.size ?? null,
      gateA,
      gateB,
      gateC,
      gateD,
      total: gateA + gateB + gateC + gateD,
      assignee: s.assignee ?? null,
      updatedAt: s.updated_at,
    };
  });
}

export function costSummary(rows: CostRow[]): CostSummary {
  const byStateMap = new Map<string, { count: number; usd: number }>();
  let total = 0;
  let gateA = 0;
  let gateB = 0;
  let gateC = 0;
  let gateD = 0;
  let withCost = 0;
  for (const r of rows) {
    total += r.total;
    gateA += r.gateA;
    gateB += r.gateB;
    gateC += r.gateC;
    gateD += r.gateD;
    if (r.total > 0) withCost++;
    const b = byStateMap.get(r.state) ?? { count: 0, usd: 0 };
    b.count++;
    b.usd += r.total;
    byStateMap.set(r.state, b);
  }
  const byState = [...byStateMap.entries()]
    .map(([state, v]) => ({ state, ...v }))
    .sort((a, b) => b.usd - a.usd);
  return { total, gateA, gateB, gateC, gateD, count: rows.length, withCost, byState };
}

const usd = (n: number): string => `$${n.toFixed(4)}`;

// CLI 文本渲染：花费降序的逐条表 + 按状态汇总 + 总计。
export function formatCost(rows: CostRow[], sum: CostSummary): string {
  if (rows.length === 0) return '（无 session）';
  const sorted = rows.slice().sort((a, b) => b.total - a.total);
  const lines: string[] = [];
  lines.push('REQ        STATE                 闸A        闸B        闸C        闸D        合计       SLUG');
  for (const r of sorted) {
    lines.push(
      `${r.ref.padEnd(10)} ${r.state.padEnd(21)} ${usd(r.gateA).padStart(9)} ${usd(r.gateB).padStart(9)} ${usd(r.gateC).padStart(9)} ${usd(r.gateD).padStart(9)} ${usd(r.total).padStart(9)}  ${r.slug.slice(0, 28)}`,
    );
  }
  lines.push('');
  lines.push('── 按状态 ──');
  for (const b of sum.byState) lines.push(`  ${b.state.padEnd(21)} ${String(b.count).padStart(3)} 条 · ${usd(b.usd)}`);
  lines.push('');
  lines.push(
    `合计 ${usd(sum.total)}（闸A ${usd(sum.gateA)} + 闸B ${usd(sum.gateB)} + 闸C ${usd(sum.gateC)} + 闸D ${usd(sum.gateD)}）· ${sum.count} 条需求，其中 ${sum.withCost} 条产生成本`,
  );
  lines.push('（私有·管理面，仅本服务可见，不写进交付/飞书/issue）');
  return lines.join('\n');
}
