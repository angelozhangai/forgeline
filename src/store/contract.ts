// Persistence for the contract-probe results: one row per dependency holding its latest state plus the
// previous one (which is what allows a flip to be debounced). It also refills the in-memory cache after the
// daemon restarts.
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

// Whether the startup contract probe is due: it runs when the **oldest** available probe is at least one
// interval old (if any dependency is stale, the whole batch is re-probed - runContractProbes probes every
// dependency in one go anyway, so a re-probe reconverges the timestamps rather than paying repeatedly).
// It uses the oldest rather than the newest so that a fresh probe cannot mask a stale one: when a dependency is
// unavailable for a round it is skipped and not persisted, so its row's timestamp falls behind. Taking the
// newest (say claude 2 hours ago and codex 50 hours ago -> "both look fresh") would skip the startup probe and
// leave the codex row stale forever.
// This also stops a crash-restart loop from paying for a probe on every start (a contract probe is a billed
// claude + codex call). Never probed at all -> run. A pure function, for unit tests.
export function startupProbeDue(probes: ProbeRow[], now: number, intervalMs: number): boolean {
  if (probes.length === 0) return true;
  const oldest = Math.min(...probes.map((p) => p.checkedAt));
  return now - oldest >= intervalMs;
}

// Insert or update one probe result. Only available probes are recorded (a skipped one is not persisted, so it
// cannot pollute the previous state).
export function upsertProbe(r: ProbeResult): void {
  if (!r.available) return;
  db()
    .prepare(
      `INSERT INTO contract_probe(dep, ok, detail, raw, checked_at) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(dep) DO UPDATE SET ok=excluded.ok, detail=excluded.detail, raw=excluded.raw, checked_at=excluded.checked_at`,
    )
    .run(r.dep, r.ok ? 1 : 0, r.detail, r.raw ?? null, r.at);
}
