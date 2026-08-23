// Throttling the contract probe at startup (so a daemon crash-restart loop does not pay for a probe on every
// start). A pure function: deterministic, free, and it does not touch the database.
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startupProbeDue } from '../src/store/contract.ts';
import type { ProbeRow } from '../src/store/contract.ts';

const row = (checkedAt: number): ProbeRow => ({ dep: 'claude', ok: true, detail: '', raw: null, checkedAt });
const HOUR = 3600_000;
const now = 1_700_000_000_000;

test('startupProbeDue: never probed -> it should run', () => {
  assert.equal(startupProbeDue([], now, 24 * HOUR), true);
});

test('startupProbeDue: everything is within the interval -> skip (a crash restart does not pay again)', () => {
  assert.equal(startupProbeDue([row(now - 1 * HOUR)], now, 24 * HOUR), false);
  // Several recent rows -> the oldest is still within the interval -> skip
  assert.equal(startupProbeDue([row(now - 3 * HOUR), row(now - 2 * HOUR)], now, 24 * HOUR), false);
});

test('startupProbeDue: it judges by the oldest row — any stale dependency triggers a re-probe (a recent probe does not mask an old one)', () => {
  // codex was probed 50h ago and claude 2h ago (a round where codex was unavailable and got skipped left its
  // row behind): taking the oldest (50h) means it should run, otherwise codex's row stays stale forever
  // (taking the most recent would wrongly conclude "everything is fresh" and skip).
  assert.equal(startupProbeDue([row(now - 50 * HOUR), row(now - 2 * HOUR)], now, 24 * HOUR), true);
});

test('startupProbeDue: the most recent is past the interval -> it should run (exactly at the interval counts as due)', () => {
  assert.equal(startupProbeDue([row(now - 25 * HOUR)], now, 24 * HOUR), true);
  assert.equal(startupProbeDue([row(now - 24 * HOUR)], now, 24 * HOUR), true); // exactly due
});
