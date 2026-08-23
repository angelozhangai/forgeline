// The rolling history: recording a sample, flip detection, the uptime and event aggregation, and pruning by
// the retain window. FORGE_DB=:memory: has to be set before the imports.
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HealthReport, Status } from '../src/health/check.ts';
// A dynamic import: root.ts must not load until FORGE_DB=':memory:' is set (DB_PATH is fixed at import time).
const { recordSample, history, lastSampleStatus } = await import('../src/health/history.ts');
const { db } = await import('../src/store/db.ts');

// The name recordSample looks for when deriving db_ok. It is coupled to check.ts by display string, which is
// exactly what the last test here pins.
const DB_CHECK_NAME = 'SQLite state store';

function mkReport(status: Status, ts: number, checkStatus: 'healthy' | 'down' = 'healthy'): HealthReport {
  return {
    status, ts, uptimeSec: 0,
    daemon: { running: status !== 'down', wedged: false, pid: 1, startedAt: 0, livenessAgeSec: 0, lastCycleAt: null, lastCycleOk: null, cycleCount: 0, activeGates: 0 },
    ws: { configured: true, connected: status !== 'down', lastEventAt: null },
    checks: [{ name: DB_CHECK_NAME, status: checkStatus, detail: '' }],
    board: { byState: {}, total: 0, awaiting: 0, failed: 0, activeGates: 0 },
  };
}

test('recordSample: flip detection (the first sample is not a flip; only a change of status is)', () => {
  const T = 2_000_000_000;
  assert.equal(recordSample(mkReport('healthy', T), 72, T).flipped, false);
  assert.equal(recordSample(mkReport('healthy', T + 1000), 72, T + 1000).flipped, false);
  const r = recordSample(mkReport('degraded', T + 2000), 72, T + 2000);
  assert.equal(r.flipped, true);
  assert.equal(r.prev, 'healthy');
  assert.equal(lastSampleStatus(), 'degraded');
});

test('history: the uptime and the flip events aggregated', () => {
  const v = history(0, 2_000_000_999);
  // Three samples: healthy, healthy, degraded -> 100% up, 66.7% normal, one flip
  assert.equal(v.count, 3);
  assert.equal(v.uptimePct, 100);
  assert.equal(v.healthyPct, 66.7);
  assert.equal(v.downPct, 0);
  assert.equal(v.events.length, 1);
  assert.deepEqual({ from: v.events[0].from, to: v.events[0].to }, { from: 'healthy', to: 'degraded' });
});

test('recordSample: prunes old samples according to retainHours', () => {
  const T = 5_000_000_000;
  recordSample(mkReport('healthy', T), 72, T); // record one
  // Another 100 hours later, with retain=72 -> the one at T is pruned
  const later = T + 100 * 3600 * 1000;
  recordSample(mkReport('down', later), 72, later);
  const v = history(0, later);
  assert.equal(v.count, 1);
  assert.equal(v.samples[0].ts, later);
});

// recordSample derives db_ok by looking the database check up **by its display name**. That coupling is
// invisible: rename the check in check.ts without renaming it here and db_ok silently becomes null forever,
// with every other assertion in this file still green. This pins it.
test('recordSample: db_ok is derived from the database check, matched by the name check.ts gives it', () => {
  const T = 7_000_000_000;
  const read = (ts: number): number | null =>
    (db().prepare('SELECT db_ok FROM health_sample WHERE ts = ?').get(ts) as { db_ok: number | null }).db_ok;

  recordSample(mkReport('healthy', T, 'healthy'), 72, T);
  assert.equal(read(T), 1, 'a healthy database check records db_ok=1');

  recordSample(mkReport('down', T + 1000, 'down'), 72, T + 1000);
  assert.equal(read(T + 1000), 0, 'a failing database check records db_ok=0');

  // A report whose checks carry no such name -> null, which is what a silent rename would produce for every
  // sample from then on.
  const renamed = mkReport('healthy', T + 2000);
  renamed.checks = [{ name: 'some other name', status: 'healthy', detail: '' }];
  recordSample(renamed, 72, T + 2000);
  assert.equal(read(T + 2000), null, 'no matching check -> null (this is the failure mode a rename would cause)');
});
