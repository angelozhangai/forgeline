// Layer 3's flip debouncing, persistence and contractCheck aggregation, proved deterministically (no
// binaries involved, and it costs nothing).
process.env.FORGE_DB = ':memory:';

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ProbeResult } from '../src/llm/probes.ts';

let alerts: { severity: string; title: string }[] = [];
mock.module('../src/health/alert.ts', {
  namedExports: { sendHealthAlert: async (severity: string, title: string) => { alerts.push({ severity, title }); } },
});

const { maybeAlertContractDrift, contractCheck } = await import('../src/health/contract.ts');
const { getProbe } = await import('../src/store/contract.ts');

const pr = (dep: ProbeResult['dep'], ok: boolean, at = 1000): ProbeResult => ({ dep, available: true, ok, detail: ok ? 'fine' : 'drift', raw: ok ? undefined : 'renamed-jsonl...', at });

// These share one :memory: database in order, advancing along a real timeline.
test('the first drift -> one degraded alert, ok=0 persisted, and contractCheck degraded', async () => {
  alerts = [];
  await maybeAlertContractDrift([pr('codex', false, 1000)]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'degraded');
  assert.match(alerts[0].title, /codex/);
  assert.equal(getProbe('codex')?.ok, false);
  const c = contractCheck(2000);
  assert.equal(c.status, 'degraded');
  assert.match(c.detail, /codex/);
});

test('a persistent drift -> no repeat alert (debounced on the flip)', async () => {
  alerts = [];
  await maybeAlertContractDrift([pr('codex', false, 3000)]);
  assert.equal(alerts.length, 0, 'one dependency drifting persistently should not spam every day');
});

test('recovery -> one recovered alert, and contractCheck healthy', async () => {
  alerts = [];
  await maybeAlertContractDrift([pr('codex', true, 5000)]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'recovered');
  assert.equal(getProbe('codex')?.ok, true);
  assert.equal(contractCheck(6000).status, 'healthy');
});

test('available=false (the probe was skipped) -> no alert and nothing persisted', async () => {
  alerts = [];
  await maybeAlertContractDrift([{ dep: 'claude', available: false, ok: false, detail: 'skip', at: 7000 }]);
  assert.equal(alerts.length, 0);
  assert.equal(getProbe('claude'), null);
});
