// 契约探针结果持久化：每依赖一行最新态 + 上次态（供翻转去抖）。守护重启后回填内存缓存。
import { db } from './db.ts';
import type { ProbeResult, ProbeDep } from '../llm/probes.ts';

export interface ProbeRow {
  dep: ProbeDep;
  ok: boolean;
  detail: string;
  raw: string | null;
  checkedAt: number;
}

function toRow(r: { dep: string; ok: number; detail: string | null; raw: string | null; checked_at: number }): ProbeRow {
  return { dep: r.dep as ProbeDep, ok: r.ok === 1, detail: r.detail ?? '', raw: r.raw, checkedAt: Number(r.checked_at) };
}

export function getProbe(dep: ProbeDep): ProbeRow | null {
  const r = db().prepare('SELECT dep, ok, detail, raw, checked_at FROM contract_probe WHERE dep = ?').get(dep) as
    | { dep: string; ok: number; detail: string | null; raw: string | null; checked_at: number }
    | undefined;
  return r ? toRow(r) : null;
}

export function allProbes(): ProbeRow[] {
  const rows = db().prepare('SELECT dep, ok, detail, raw, checked_at FROM contract_probe').all() as {
    dep: string;
    ok: number;
    detail: string | null;
    raw: string | null;
    checked_at: number;
  }[];
  return rows.map(toRow);
}

// 启动契约探测是否该跑：**最旧**一条 available 探针距今 ≥ 间隔即跑（任一依赖陈旧就重探整批——
// runContractProbes 本就一次探全部依赖，重探会让时间戳重新收敛，不会反复付费）。用最旧而非最新：
// 避免一条新探针遮住另一条陈旧探针——某依赖某轮 unavailable 被跳过（不落库）时其行时间戳会滞后，
// 若取最新（如 claude 2h 前、codex 50h 前 → 误判「都新」）就会跳过启动探测，让 codex 行永远陈旧。
// 防 daemon 崩溃重启循环时每次启动都付费探一次（契约探测是付费 claude+codex 调用）。从没探过 → 跑。纯函数，供单测。
export function startupProbeDue(probes: ProbeRow[], now: number, intervalMs: number): boolean {
  if (probes.length === 0) return true;
  const oldest = Math.min(...probes.map((p) => p.checkedAt));
  return now - oldest >= intervalMs;
}

// 写入/更新一条探针结果。仅记 available 的探针（跳过的不落库，免污染上次态）。
export function upsertProbe(r: ProbeResult): void {
  if (!r.available) return;
  db()
    .prepare(
      `INSERT INTO contract_probe(dep, ok, detail, raw, checked_at) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(dep) DO UPDATE SET ok=excluded.ok, detail=excluded.detail, raw=excluded.raw, checked_at=excluded.checked_at`,
    )
    .run(r.dep, r.ok ? 1 : 0, r.detail, r.raw ?? null, r.at);
}
