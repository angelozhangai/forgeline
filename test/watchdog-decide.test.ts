// The truth table of the watchdog's pure decision function: healthz answering or not x liveness fresh or
// stale x activeGates x the process running or not -> the expected action.
// It touches neither the real launchctl nor the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideWatchdogAction } from '../src/health/watchdog.ts';
import type { WatchdogInput } from '../src/health/watchdog.ts';
import { HEALTH_DEFAULTS } from '../src/health/config.ts';
import type { Heartbeat } from '../src/health/heartbeat.ts';

const cfg = HEALTH_DEFAULTS;
const NOW = 1_000_000_000;
function hb(over: Partial<Heartbeat> = {}): Heartbeat {
  return {
    pid: 99, port: 4319, startedAt: 0, livenessPingAt: NOW, lastCycleAt: null, lastCycleOk: null,
    cycleCount: 0, wsConfigured: true, wsConnected: true, wsLastEventAt: null, activeGates: 0, ...over,
  };
}
function input(over: Partial<WatchdogInput> = {}): WatchdogInput {
  return { running: true, healthzOk: true, consecutiveFails: 0, hb: hb(), now: NOW, cfg, wedgedSince: null, ...over };
}
const stale = NOW - (cfg.wedgedAfterSec + 30) * 1000;

test('the process is not running -> restart (without a kill) / process-down', () => {
  const d = decideWatchdogAction(input({ running: false, hb: null, healthzOk: false }));
  assert.equal(d.action.kind, 'restart');
  assert.equal(d.action.kind === 'restart' && d.action.force, false);
  assert.equal(d.klass, 'process-down');
});

test('the probe answers and liveness is fresh -> none / ok', () => {
  const d = decideWatchdogAction(input());
  assert.equal(d.action.kind, 'none');
  assert.equal(d.klass, 'ok');
});

test('wedged with no gate running -> restart (with a kill) / wedged', () => {
  const d = decideWatchdogAction(input({
    healthzOk: false, consecutiveFails: cfg.probeFailThreshold,
    hb: hb({ livenessPingAt: stale, activeGates: 0 }),
  }));
  assert.equal(d.action.kind, 'restart');
  assert.equal(d.action.kind === 'restart' && d.action.force, true);
  assert.equal(d.klass, 'wedged');
});

test('wedged with a gate running, the first time -> defer / wedged-deferred (recording wedgedSince)', () => {
  const d = decideWatchdogAction(input({
    healthzOk: false, consecutiveFails: cfg.probeFailThreshold,
    hb: hb({ livenessPingAt: stale, activeGates: 2 }), wedgedSince: null,
  }));
  assert.equal(d.action.kind, 'defer');
  assert.equal(d.klass, 'wedged-deferred');
  assert.equal(d.wedgedSince, NOW);
});

test('wedged with a gate running and the grace window passed -> restart (with a kill) / wedged', () => {
  const d = decideWatchdogAction(input({
    healthzOk: false, consecutiveFails: cfg.probeFailThreshold,
    hb: hb({ livenessPingAt: stale, activeGates: 2 }),
    wedgedSince: NOW - (cfg.wedgedGraceSec + 1) * 1000,
  }));
  assert.equal(d.action.kind, 'restart');
  assert.equal(d.action.kind === 'restart' && d.action.force, true);
  assert.equal(d.klass, 'wedged');
});

test('the probe keeps failing but liveness is fresh (http died while the loop is alive) -> alert / http-degraded (nothing is killed)', () => {
  const d = decideWatchdogAction(input({
    healthzOk: false, consecutiveFails: cfg.probeFailThreshold,
    hb: hb({ livenessPingAt: NOW, activeGates: 0 }),
  }));
  assert.equal(d.action.kind, 'alert');
  assert.equal(d.klass, 'http-degraded');
});

test('a single probe failure below the threshold -> none / ok (debounced)', () => {
  const d = decideWatchdogAction(input({
    healthzOk: false, consecutiveFails: 1,
    hb: hb({ livenessPingAt: stale, activeGates: 0 }),
  }));
  assert.equal(d.action.kind, 'none');
  assert.equal(d.klass, 'ok');
});
