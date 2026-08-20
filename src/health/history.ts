// 滚动健康历史：守护每 ~60s 落一行采样，状态页画近 N 小时在线率 + 宕机/恢复事件时间线。
// 按 health.history_retain_hours 剪枝（旧样本删掉，库不膨胀）。
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

// 上一条采样的总状态（去抖/翻转检测用）。
export function lastSampleStatus(): Status | null {
  const row = db().prepare('SELECT status FROM health_sample ORDER BY ts DESC LIMIT 1').get() as { status: Status } | undefined;
  return row?.status ?? null;
}

// 落一行采样 + 剪枝，返回是否相对上一条翻转（用于告警去抖）。
export function recordSample(report: HealthReport, retainHours: number, now: number = report.ts): FlipResult {
  const prev = lastSampleStatus();
  const wsState = !report.ws.configured ? 'na' : report.ws.connected ? 'connected' : 'disconnected';
  const dbCheck = report.checks.find((c) => c.name === 'SQLite 状态库');
  const dbOk = dbCheck ? (dbCheck.status === 'healthy' ? 1 : 0) : null;
  const detail = JSON.stringify(report.checks.filter((c) => c.status !== 'healthy' && c.status !== 'na').map((c) => `${c.name}:${c.status}`));
  db()
    .prepare('INSERT INTO health_sample (ts, status, ws, db_ok, active_gates, detail) VALUES (?,?,?,?,?,?)')
    .run(now, report.status, wsState, dbOk, report.daemon.activeGates, detail);
  // 剪枝
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
  uptimePct: number; // status != down 的样本占比
  healthyPct: number;
  degradedPct: number;
  downPct: number;
  events: HistoryEvent[]; // 总状态翻转点（宕机/恢复时间线）
  samples: SampleRow[];
}

// 近 sinceMs..now 的历史聚合：在线率 + 翻转事件 + 原始采样（状态页画横条）。
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
