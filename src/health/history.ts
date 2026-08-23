// The rolling health history: the daemon records one sample row roughly every 60 seconds, and the status page
// draws the uptime over the last N hours plus a timeline of outages and recoveries.
// Pruned according to health.history_retain_hours (old samples are deleted, so the database does not grow
// without bound).
import { db } from '../store/db.ts';
import { hours } from '../util/time.ts';
import type { HealthReport, Status } from './check.ts';

export interface SampleRow {
  ts: number;
  status: Status;
  ws: string | null;
  active_gates: number | null;
}

export interface FlipResult {
  flipped: boolean;
  prev: Status | null;
  curr: Status;
}

// The overall status of the previous sample (used for debouncing and flip detection).
export function lastSampleStatus(): Status | null {
  const row = db().prepare('SELECT status FROM health_sample ORDER BY ts DESC LIMIT 1').get() as { status: Status } | undefined;
  return row?.status ?? null;
}

// Record one sample row and prune, returning whether it flipped relative to the previous one (which is what
// debounces the alerting).
export function recordSample(report: HealthReport, retainHours: number, now: number = report.ts): FlipResult {
  const prev = lastSampleStatus();
  const wsState = !report.ws.configured ? 'na' : report.ws.connected ? 'connected' : 'disconnected';
  // Matched against the name check.ts gives this check. The coupling is by display string, so the two have to
  // move together — renaming it there without renaming it here would leave db_ok silently null forever.
  const dbCheck = report.checks.find((c) => c.name === 'SQLite state store');
  const dbOk = dbCheck ? (dbCheck.status === 'healthy' ? 1 : 0) : null;
  const detail = JSON.stringify(report.checks.filter((c) => c.status !== 'healthy' && c.status !== 'na').map((c) => `${c.name}:${c.status}`));
  db()
    .prepare('INSERT INTO health_sample (ts, status, ws, db_ok, active_gates, detail) VALUES (?,?,?,?,?,?)')
    .run(now, report.status, wsState, dbOk, report.daemon.activeGates, detail);
  // Prune
  db().prepare('DELETE FROM health_sample WHERE ts < ?').run(now - hours(retainHours));
  return { flipped: prev !== null && prev !== report.status, prev, curr: report.status };
}

export interface HistoryEvent {
  ts: number;
  from: Status;
  to: Status;
}

export interface HistoryView {
  since: number;
  now: number;
  count: number;
  uptimePct: number; // the share of samples whose status is not down
  healthyPct: number;
  degradedPct: number;
  downPct: number;
  events: HistoryEvent[]; // where the overall status flipped (the outage and recovery timeline)
  samples: SampleRow[];
}

// The history aggregated over sinceMs..now: the uptime, the flip events, and the raw samples (which the
// status page draws as a bar).
export function history(sinceMs: number, now: number = Date.now()): HistoryView {
  const rows = db()
    .prepare('SELECT ts, status, ws, active_gates FROM health_sample WHERE ts >= ? ORDER BY ts ASC')
    .all(sinceMs) as unknown as SampleRow[];
  const n = rows.length;
  const count = (s: Status): number => rows.filter((r) => r.status === s).length;
  const healthy = count('healthy');
  const degraded = count('degraded');
  const down = count('down');
  const pct = (x: number): number => (n === 0 ? 100 : Math.round((x / n) * 1000) / 10);
  const events: HistoryEvent[] = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].status !== rows[i - 1].status) {
      events.push({ ts: rows[i].ts, from: rows[i - 1].status, to: rows[i].status });
    }
  }
  return {
    since: sinceMs,
    now,
    count: n,
    uptimePct: pct(healthy + degraded),
    healthyPct: pct(healthy),
    degradedPct: pct(degraded),
    downPct: pct(down),
    events,
    samples: rows,
  };
}
