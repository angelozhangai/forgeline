// 心跳：原子写/读往返 + 字段推进 + 缺失→null。须在导入前设 FORGE_HEARTBEAT 隔离到临时文件。
process.env.FORGE_HEARTBEAT = '/tmp/forge-test-hb.json';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
// 动态 import：ESM 的静态 import 会在顶部 env 赋值【之前】求值，须等设好 FORGE_HEARTBEAT 再载入 root.ts。
const { initHeartbeat, pingLiveness, markCycle, markWs, readHeartbeat, _resetForTest } = await import('../src/health/heartbeat.ts');

const PATH = '/tmp/forge-test-hb.json';

test('heartbeat 原子写/读往返 + 字段推进', () => {
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

test('readHeartbeat：文件缺失 → null（不崩）', () => {
  rmSync(PATH, { force: true });
  _resetForTest();
  assert.equal(readHeartbeat(), null);
});

test('readHeartbeat：内容损坏 → null', () => {
  _resetForTest();
  writeFileSync(PATH, '{not json', 'utf8');
  assert.equal(readHeartbeat(), null);
  rmSync(PATH, { force: true });
});
