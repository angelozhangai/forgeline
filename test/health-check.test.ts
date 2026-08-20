// 健康分级纯函数：classifyDaemon / classifyWs / rollupStatus。不碰 DB/网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDaemon, classifyWs, rollupStatus } from '../src/health/check.ts';
import type { Check } from '../src/health/check.ts';
import { HEALTH_DEFAULTS } from '../src/health/config.ts';
import type { Heartbeat } from '../src/health/heartbeat.ts';

const cfg = HEALTH_DEFAULTS;
function hb(over: Partial<Heartbeat> = {}): Heartbeat {
  return {
    pid: 1, port: 4319, startedAt: 0, livenessPingAt: 0, lastCycleAt: null, lastCycleOk: null,
    cycleCount: 0, wsConfigured: false, wsConnected: false, wsLastEventAt: null, activeGates: 0, ...over,
  };
}

test('classifyDaemon：心跳缺失 → down/未运行', () => {
  const d = classifyDaemon(null, 1_000_000, cfg);
  assert.equal(d.check.status, 'down');
  assert.equal(d.running, false);
  assert.equal(d.wedged, false);
});

test('classifyDaemon：liveness 新鲜 → healthy/running', () => {
  const now = 1_000_000;
  const d = classifyDaemon(hb({ livenessPingAt: now }), now, cfg);
  assert.equal(d.check.status, 'healthy');
  assert.equal(d.running, true);
  assert.equal(d.wedged, false);
  assert.equal(d.livenessAgeSec, 0);
});

test('classifyDaemon：liveness 过期 → down/wedged', () => {
  const now = 1_000_000;
  const d = classifyDaemon(hb({ livenessPingAt: now - (cfg.wedgedAfterSec + 10) * 1000 }), now, cfg);
  assert.equal(d.check.status, 'down');
  assert.equal(d.wedged, true);
  assert.equal(d.running, false);
});

test('classifyWs：未配 → na；配了断 → degraded；连上 → healthy', () => {
  assert.equal(classifyWs(null).status, 'na');
  assert.equal(classifyWs(hb({ wsConfigured: false })).status, 'na');
  assert.equal(classifyWs(hb({ wsConfigured: true, wsConnected: false })).status, 'degraded');
  assert.equal(classifyWs(hb({ wsConfigured: true, wsConnected: true })).status, 'healthy');
});

test('rollupStatus：取最坏（down>degraded>healthy；na 不计）', () => {
  const c = (status: Check['status']): Check => ({ name: 'x', status, detail: '' });
  assert.equal(rollupStatus([c('healthy'), c('na')]), 'healthy');
  assert.equal(rollupStatus([c('healthy'), c('degraded'), c('na')]), 'degraded');
  assert.equal(rollupStatus([c('degraded'), c('down'), c('healthy')]), 'down');
  assert.equal(rollupStatus([]), 'healthy');
});
