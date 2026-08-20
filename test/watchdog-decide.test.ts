// 看门狗决策纯函数真值表：healthz 通/断 × liveness 新/旧 × activeGates × 进程在/不在 → 期望动作。
// 不碰真 launchctl / 网络。
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

test('进程未运行 → restart(非强杀)/process-down', () => {
  const d = decideWatchdogAction(input({ running: false, hb: null, healthzOk: false }));
  assert.equal(d.action.kind, 'restart');
  assert.equal(d.action.kind === 'restart' && d.action.force, false);
  assert.equal(d.klass, 'process-down');
});

test('探针通 + liveness 新鲜 → none/ok', () => {
  const d = decideWatchdogAction(input());
  assert.equal(d.action.kind, 'none');
  assert.equal(d.klass, 'ok');
});

test('卡死 + 无 gate → restart(强杀)/wedged', () => {
  const d = decideWatchdogAction(input({
    healthzOk: false, consecutiveFails: cfg.probeFailThreshold,
    hb: hb({ livenessPingAt: stale, activeGates: 0 }),
  }));
  assert.equal(d.action.kind, 'restart');
  assert.equal(d.action.kind === 'restart' && d.action.force, true);
  assert.equal(d.klass, 'wedged');
});

test('卡死 + 有 gate + 首次 → defer/wedged-deferred（记 wedgedSince）', () => {
  const d = decideWatchdogAction(input({
    healthzOk: false, consecutiveFails: cfg.probeFailThreshold,
    hb: hb({ livenessPingAt: stale, activeGates: 2 }), wedgedSince: null,
  }));
  assert.equal(d.action.kind, 'defer');
  assert.equal(d.klass, 'wedged-deferred');
  assert.equal(d.wedgedSince, NOW);
});

test('卡死 + 有 gate + 宽限窗已过 → restart(强杀)/wedged', () => {
  const d = decideWatchdogAction(input({
    healthzOk: false, consecutiveFails: cfg.probeFailThreshold,
    hb: hb({ livenessPingAt: stale, activeGates: 2 }),
    wedgedSince: NOW - (cfg.wedgedGraceSec + 1) * 1000,
  }));
  assert.equal(d.action.kind, 'restart');
  assert.equal(d.action.kind === 'restart' && d.action.force, true);
  assert.equal(d.klass, 'wedged');
});

test('探针连续失败但 liveness 新鲜（http 挂了循环还活）→ alert/http-degraded（不强杀）', () => {
  const d = decideWatchdogAction(input({
    healthzOk: false, consecutiveFails: cfg.probeFailThreshold,
    hb: hb({ livenessPingAt: NOW, activeGates: 0 }),
  }));
  assert.equal(d.action.kind, 'alert');
  assert.equal(d.klass, 'http-degraded');
});

test('单次探针失败未到阈值 → none/ok（去抖）', () => {
  const d = decideWatchdogAction(input({
    healthzOk: false, consecutiveFails: 1,
    hb: hb({ livenessPingAt: stale, activeGates: 0 }),
  }));
  assert.equal(d.action.kind, 'none');
  assert.equal(d.klass, 'ok');
});
