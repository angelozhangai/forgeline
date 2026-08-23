// The contract smoke test against the real binaries: it really runs codex/claude/gh/the IM API and asserts
// the envelope fields are still there.
// Two gates: (1) a missing binary or configuration -> skip (CI's ubuntu has none of these binaries, so it
// skips automatically and stays green); (2) FORGE_CONTRACT_LIVE=1 not set -> skip (the codex and claude
// probes cost real money, so an ordinary local npm test does not spend anything).
// To really run it: `FORGE_CONTRACT_LIVE=1 npm test` on your own machine, or the scheduled
// `forge contract-check`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandExists } from '../src/util/proc.ts';
import { probeCodex, probeClaude, probeGh, probeIm } from '../src/llm/probes.ts';

const LIVE = process.env.FORGE_CONTRACT_LIVE === '1';
const now = 1_700_000_000_000; // a fixed injected clock (avoiding Date.now; the schema does not depend on it)

test('contract: codex (the real binary)', { skip: !LIVE || !commandExists('codex') }, async () => {
  const r = await probeCodex(now);
  assert.ok(r.ok, `the codex contract has drifted: ${r.detail}`);
});

test('contract: claude (the real binary)', { skip: !LIVE || !commandExists('claude') }, async () => {
  const r = await probeClaude(now);
  assert.ok(r.ok, `the claude contract has drifted: ${r.detail}`);
});

test('contract: gh (the real binary; read-only and free)', { skip: !LIVE || !commandExists('gh') }, async () => {
  const r = await probeGh(now);
  assert.ok(r.ok, `the gh contract has drifted: ${r.detail}`);
});

test('contract: the IM API (a canary; read-only and free)', { skip: !LIVE }, async () => {
  const r = await probeIm(now);
  if (!r.available) return; // not fully configured -> not a failure
  assert.ok(r.ok, `the IM contract has drifted: ${r.detail}`);
});
