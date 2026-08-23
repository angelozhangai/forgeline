// The cost board (private, management-facing): the dollars each requirement spent on claude across gates A,
// B, C and D. codex's --json reports no dollar figure, so only claude is counted, matching what `show`
// reports. These are pure functions — the CLI filters first and feeds them in, which makes them easy to
// unit-test.
// ⚠️ Like the PRD scores and the per-person load, this belongs to the management surface: visible only inside
// this service, and never written into a delivery document, IM, or an issue.
import type { Session } from './types.ts';

export interface CostRow {
  ref: string; // REQ-N (or the first 8 characters of the id)
  slug: string;
  state: string;
  size: string | null;
  gateA: number; // the dollars spent on Gate A's review and its adversarial revisions
  gateB: number; // the dollars spent on Gate B's revisions
  gateC: number; // the dollars spent on Gate C's implementation and CI loop (downstream, and the bulk of it)
  gateD: number; // the dollars spent on Gate D's PR review, revisions and hardening (downstream, and the bulk of it)
  total: number;
  assignee: string | null;
  updatedAt: number;
}

export interface CostSummary {
  total: number; // the total dollars across every requirement
  gateA: number;
  gateB: number;
  gateC: number;
  gateD: number;
  count: number; // how many requirements are counted
  withCost: number; // how many of them actually cost anything
  byState: { state: string; count: number; usd: number }[]; // bucketed by state (most expensive first)
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

// The CLI's text rendering: a row per requirement, most expensive first, then the summary by state and the
// total.
export function formatCost(rows: CostRow[], sum: CostSummary): string {
  if (rows.length === 0) return '(no sessions)';
  const sorted = rows.slice().sort((a, b) => b.total - a.total);
  const lines: string[] = [];
  lines.push('REQ        STATE                 GATE A     GATE B     GATE C     GATE D     TOTAL      SLUG');
  for (const r of sorted) {
    lines.push(
      `${r.ref.padEnd(10)} ${r.state.padEnd(21)} ${usd(r.gateA).padStart(9)} ${usd(r.gateB).padStart(9)} ${usd(r.gateC).padStart(9)} ${usd(r.gateD).padStart(9)} ${usd(r.total).padStart(9)}  ${r.slug.slice(0, 28)}`,
    );
  }
  lines.push('');
  lines.push('-- By state --');
  for (const b of sum.byState) lines.push(`  ${b.state.padEnd(21)} ${String(b.count).padStart(3)} rows · ${usd(b.usd)}`);
  lines.push('');
  lines.push(
    `Total ${usd(sum.total)} (Gate A ${usd(sum.gateA)} + Gate B ${usd(sum.gateB)} + Gate C ${usd(sum.gateC)} + Gate D ${usd(sum.gateD)}) · ${sum.count} requirements, ${sum.withCost} of which cost anything`,
  );
  lines.push('(private, management-facing: visible only to this service, and never written into a delivery document, IM, or an issue)');
  return lines.join('\n');
}
