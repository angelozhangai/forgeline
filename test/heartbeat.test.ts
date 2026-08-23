// The heartbeat: the atomic write/read round-trip, the fields advancing, and missing -> null.
// FORGE_HEARTBEAT has to be set before the imports so it is isolated to a temporary file.
process.env.FORGE_HEARTBEAT = '/tmp/forge-test-hb.json';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
// A dynamic import: an ESM static import evaluates **before** the env assignment at the top, so root.ts must
// not load until FORGE_HEARTBEAT is set.
const { initHeartbeat, pingLiveness, markCycle, markWs, readHeartbeat, _resetForTest } = await import('../src/health/heartbeat.ts');

const PATH = '/tmp/forge-test-hb.json';

test('the heartbeat: the atomic write/read round-trip, and the fields advancing', () => {
  rmSync(PATH, { force: true });
  _resetForTest();
  const t0 = 1_000_000;
  initHeartbeat({ pid: 4242, port: 4319, wsConfigured: true, now: t0 });
  let hb = readHeartbeat();
  assert.equal(hb!.pid, 4242);
  assert.equal(hb!.startedAt, t0);
  assert.equal(hb!.cycleCount, 0);
  assert.equal(hb!.wsConfigured, true);

  pingLiveness(t0 + 5000, 2);
  hb = readHeartbeat();
  assert.equal(hb!.livenessPingAt, t0 + 5000);
  assert.equal(hb!.activeGates, 2);

  markCycle(t0 + 6000, true);
  hb = readHeartbeat();
  assert.equal(hb!.cycleCount, 1);
  assert.equal(hb!.lastCycleAt, t0 + 6000);
  assert.equal(hb!.lastCycleOk, true);

  markWs(true, t0 + 7000);
  hb = readHeartbeat();
  assert.equal(hb!.wsConnected, true);
  assert.equal(hb!.wsLastEventAt, t0 + 7000);
});

test('readHeartbeat: the file is missing -> null (it does not crash)', () => {
  rmSync(PATH, { force: true });
  _resetForTest();
  assert.equal(readHeartbeat(), null);
});

test('readHeartbeat: the contents are corrupt -> null', () => {
  _resetForTest();
  writeFileSync(PATH, '{not json', 'utf8');
  assert.equal(readHeartbeat(), null);
  rmSync(PATH, { force: true });
});
