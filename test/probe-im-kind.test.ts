// probeIm has to pass the adapter's kind (auth or drift, from port.probe) straight through to ProbeResult.
// The regression it guards: probeIm used to drop kind, so an authentication failure -- an expired Feishu
// token, or the bot never added to the channel -- fell through to health/contract's default drift wording,
// which sent people off to edit src/llm/contract.ts and missed the expired-credentials case #1 exists to catch.
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Only port.probe() is replaced, since that is all probeIm uses, and it keeps the real Feishu API out of it.
let fake: { available: boolean; ok: boolean; detail: string; kind?: 'auth' | 'drift'; raw?: string };
mock.module('../src/messaging/index.ts', { namedExports: { port: { probe: async () => fake } } });
const { probeIm } = await import('../src/llm/probes.ts');

const now = 1_700_000_000_000; // a fixed injected clock, so nothing depends on Date.now

test('probeIm: an authentication or permission failure passes kind=auth straight through, never degrading to drift', async () => {
  fake = { available: true, ok: false, kind: 'auth', detail: 'im/v1/messages code=99991663 (a permission problem, or the bot was never added to the channel)' };
  const r = await probeIm(now);
  assert.equal(r.dep, 'im');
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'auth'); // the point: it passes through, or the alert falls back to the "go edit contract.ts" default
});

test('probeIm: a missing envelope field passes kind=drift straight through', async () => {
  fake = { available: true, ok: false, kind: 'drift', detail: 'the pagination envelope field is missing', raw: '{}' };
  const r = await probeIm(now);
  assert.equal(r.kind, 'drift');
  assert.equal(r.raw, '{}'); // raw passes through too, so the alert can carry the original text
});

test('probeIm: not fully configured gives available=false, passed through with no kind, and raises no alert', async () => {
  fake = { available: false, ok: false, detail: 'the Feishu bot or the watched channels are not fully configured (skipped)' };
  const r = await probeIm(now);
  assert.equal(r.available, false);
  assert.equal(r.kind, undefined);
});

test('probeIm: an intact envelope gives ok=true with no kind', async () => {
  fake = { available: true, ok: true, detail: "Feishu's im/v1/messages pagination envelope is intact" };
  const r = await probeIm(now);
  assert.equal(r.ok, true);
  assert.equal(r.kind, undefined);
});
