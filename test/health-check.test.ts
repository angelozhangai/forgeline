// The pure health classification functions: classifyDaemon / classifyWs / rollupStatus. They touch neither
// the database nor the network.
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

test('classifyDaemon: no heartbeat -> down and not running', () => {
  const d = classifyDaemon(null, 1_000_000, cfg);
  assert.equal(d.check.status, 'down');
  assert.equal(d.running, false);
  assert.equal(d.wedged, false);
});

test('classifyDaemon: fresh liveness -> healthy and running', () => {
  const now = 1_000_000;
  const d = classifyDaemon(hb({ livenessPingAt: now }), now, cfg);
  assert.equal(d.check.status, 'healthy');
  assert.equal(d.running, true);
  assert.equal(d.wedged, false);
  assert.equal(d.livenessAgeSec, 0);
});

test('classifyDaemon: stale liveness -> down and wedged', () => {
  const now = 1_000_000;
  const d = classifyDaemon(hb({ livenessPingAt: now - (cfg.wedgedAfterSec + 10) * 1000 }), now, cfg);
  assert.equal(d.check.status, 'down');
  assert.equal(d.wedged, true);
  assert.equal(d.running, false);
});

test("classifyWs: the entry's name follows the provider in effect (a deployment that switched to Slack should not see the other provider's name on its status page)", () => {
  assert.equal(classifyWs(hb({ wsConfigured: true, wsConnected: true }), 'slack').name, 'slack connection');
  assert.equal(classifyWs(null, 'feishu').name, 'feishu connection');
  assert.equal(classifyWs(null).name, 'IM connection', 'with no provider name given it falls back to something neutral rather than assuming one');
});

test('classifyWs: unconfigured -> na; configured but disconnected -> degraded; connected -> healthy', () => {
  assert.equal(classifyWs(null).status, 'na');
  assert.equal(classifyWs(hb({ wsConfigured: false })).status, 'na');
  assert.equal(classifyWs(hb({ wsConfigured: true, wsConnected: false })).status, 'degraded');
  assert.equal(classifyWs(hb({ wsConfigured: true, wsConnected: true })).status, 'healthy');
});

test('rollupStatus: takes the worst (down > degraded > healthy; na does not count)', () => {
  const c = (status: Check['status']): Check => ({ name: 'x', status, detail: '' });
  assert.equal(rollupStatus([c('healthy'), c('na')]), 'healthy');
  assert.equal(rollupStatus([c('healthy'), c('degraded'), c('na')]), 'degraded');
  assert.equal(rollupStatus([c('degraded'), c('down'), c('healthy')]), 'down');
  assert.equal(rollupStatus([]), 'healthy');
});
