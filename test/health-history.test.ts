// 滚动历史：采样落库 + 翻转检测 + 在线率/事件聚合 + 按 retain 剪枝。须在导入前设 FORGE_DB=:memory:。
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HealthReport, Status } from '../src/health/check.ts';
// 动态 import：须等设好 FORGE_DB=:memory: 再载入 root.ts（DB_PATH 在 import 时定）。
const { recordSample, history, lastSampleStatus } = await import('../src/health/history.ts');

function mkReport(status: Status, ts: number): HealthReport {
  return {
    status, ts, uptimeSec: 0,
    daemon: { running: status !== 'down', wedged: false, pid: 1, startedAt: 0, livenessAgeSec: 0, lastCycleAt: null, lastCycleOk: null, cycleCount: 0, activeGates: 0 },
    ws: { configured: true, connected: status !== 'down', lastEventAt: null },
    checks: [{ name: 'SQLite 状态库', status: 'healthy', detail: '' }],
    board: { byState: {}, total: 0, awaiting: 0, failed: 0, activeGates: 0 },
  };
}

test('recordSample：翻转检测（首条不算翻转，状态变才算）', () => {
  const T = 2_000_000_000;
  assert.equal(recordSample(mkReport('healthy', T), 72, T).flipped, false);
  assert.equal(recordSample(mkReport('healthy', T + 1000), 72, T + 1000).flipped, false);
  const r = recordSample(mkReport('degraded', T + 2000), 72, T + 2000);
  assert.equal(r.flipped, true);
  assert.equal(r.prev, 'healthy');
  assert.equal(lastSampleStatus(), 'degraded');
});

test('history：在线率 + 翻转事件聚合', () => {
  const v = history(0, 2_000_000_999);
  // 三条样本：healthy, healthy, degraded → 在线 100%，正常 66.7%，一次翻转
  assert.equal(v.count, 3);
  assert.equal(v.uptimePct, 100);
  assert.equal(v.healthyPct, 66.7);
  assert.equal(v.downPct, 0);
  assert.equal(v.events.length, 1);
  assert.deepEqual({ from: v.events[0].from, to: v.events[0].to }, { from: 'healthy', to: 'degraded' });
});

test('recordSample：按 retainHours 剪枝旧样本', () => {
  const T = 5_000_000_000;
  recordSample(mkReport('healthy', T), 72, T); // 落一条
  // 100 小时后再落一条，retain=72 → T 那条被剪掉
  const later = T + 100 * 3600 * 1000;
  recordSample(mkReport('down', later), 72, later);
  const v = history(0, later);
  assert.equal(v.count, 1);
  assert.equal(v.samples[0].ts, later);
});
