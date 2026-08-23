// How contract and credential alerts are routed: maybeAlertContractDrift uses `kind` to tell "authentication
// has lapsed" apart from "the schema drifted", and gives the operator **the right remedy** (log in again, as
// opposed to editing contract.ts). This goes straight at making "the token expired and the pipeline silently
// seized" something you can act on.
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const alerts: { kind: string; title: string; lines: string[] }[] = [];
mock.module('../src/health/alert.ts', {
  namedExports: {
    sendHealthAlert: async (kind: string, title: string, lines: string[]) => {
      alerts.push({ kind, title, lines });
      return true;
    },
  },
});
let stored: Record<string, { ok: boolean }> = {};
mock.module('../src/store/contract.ts', {
  namedExports: {
    getProbe: (dep: string) => stored[dep] ?? null,
    upsertProbe: (r: { dep: string; ok: boolean }) => { stored[r.dep] = { ok: r.ok }; },
    allProbes: () => Object.entries(stored).map(([dep, v]) => ({ dep, ok: v.ok })),
  },
});

const { maybeAlertContractDrift } = await import('../src/health/contract.ts');

test('kind=auth -> a 🔑 authentication alert with "log in again" guidance (not "edit contract.ts")', async () => {
  alerts.length = 0; stored = {};
  await maybeAlertContractDrift([{ dep: 'gh', available: true, ok: false, kind: 'auth', detail: 'gh exited non-zero (possibly not logged in)', at: 1 }]);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /authentication/);
  assert.ok(alerts[0].lines.some((l) => l.includes('gh auth login')));
  assert.ok(!alerts[0].lines.some((l) => l.includes('contract.ts'))); // an auth failure must not misdirect someone into editing the envelope
});

test("IM kind=auth -> the 🔑 alert uses the remedy **the adapter reported for itself** (not 'edit contract.ts')", async () => {
  alerts.length = 0; stored = {};
  // authFix comes from the provider: how to fix a Feishu token is Feishu's knowledge, and the core does not
  // speak for it (switching to Slack means a different sentence).
  await maybeAlertContractDrift([
    { dep: 'im', available: true, ok: false, kind: 'auth', authFix: 'Check the Feishu bot credentials and permissions (FEISHU_BOT_APP_ID/SECRET, and whether the bot has been added to the chat)', detail: 'im/v1/messages code=99991663 (a permission, or the bot is not in the chat)', at: 1 },
  ]);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /authentication/);
  assert.ok(alerts[0].lines.some((l) => l.includes('Feishu bot credentials')));
  assert.ok(!alerts[0].lines.some((l) => l.includes('contract.ts'))); // an auth failure must not misdirect someone into editing the envelope
});

test('IM kind=auth but the adapter gave no authFix -> fall back to the generic wording rather than pretending to know the fix', async () => {
  alerts.length = 0; stored = {};
  await maybeAlertContractDrift([{ dep: 'im', available: true, ok: false, kind: 'auth', detail: 'the token has lapsed', at: 1 }]);
  assert.ok(alerts[0].lines.some((l) => l.includes("check that tool's login state")));
});

test('kind=drift -> a contract-drift alert pointing at contract.ts', async () => {
  alerts.length = 0; stored = {};
  await maybeAlertContractDrift([{ dep: 'codex', available: true, ok: false, kind: 'drift', detail: 'thread.started is missing', at: 1 }]);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /contract has drifted/);
  assert.ok(alerts[0].lines.some((l) => l.includes('contract.ts')));
});

test('available=false (skipped) or ok (fine) -> no alert', async () => {
  alerts.length = 0; stored = {};
  await maybeAlertContractDrift([
    { dep: 'gh', available: false, ok: false, at: 1 },
    { dep: 'codex', available: true, ok: true, at: 1 },
  ]);
  assert.equal(alerts.length, 0);
});

test('debounced on the flip: a persistent failure alerts once (the second round in the same state sends nothing)', async () => {
  alerts.length = 0; stored = {};
  const bad = [{ dep: 'gh' as const, available: true, ok: false, kind: 'auth' as const, detail: 'x', at: 1 }];
  await maybeAlertContractDrift(bad); // fine -> broken: it alerts
  await maybeAlertContractDrift(bad); // broken -> broken: it does not
  assert.equal(alerts.length, 1);
});
