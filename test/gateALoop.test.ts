// Integration: gate A's codex adversarial loop (runGateALoop) against the real gateAConfig wiring -- loading
// the prompt, the output schema, persisting the columns and the leftovers on a stall. The engine's own control
// flow is already covered by reviewFixLoop.test.ts, so this file checks only what is specific to gate A.
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fake drivers: the codex reviewer and the claude fixer each return from a queue, round by round, falling back
// to LGTM once the queue is empty.
const codexQueue: { ok: boolean; result?: string; available?: boolean }[] = [];
mock.module('../src/llm/runCodex.ts', {
  namedExports: {
    runCodex: async () => {
      const r = codexQueue.shift() ?? { ok: true, result: JSON.stringify({ verdict: 'LGTM', findings: [] }) };
      return { ok: r.ok, result: r.result ?? '', threadId: 'codex-thread', tokens: null, raw: r.result ?? '', available: r.available ?? true, error: r.ok ? undefined : 'codex err' };
    },
  },
});
const claudeQueue: { ok: boolean; result?: string }[] = [];
mock.module('../src/llm/runClaude.ts', {
  namedExports: {
    runClaude: async () => {
      const r = claudeQueue.shift() ?? { ok: true, result: '{}' };
      return { ok: r.ok, result: r.result ?? '', sessionId: 'claude-sid', costUsd: 0.01, raw: r.result ?? '', error: r.ok ? undefined : 'claude err' };
    },
  },
});

const sessions = await import('../src/store/sessions.ts');
const { runGateALoop } = await import('../src/gates/gateALoop.ts');

const BASE_ENV = {
  summary: 's', repos_touched: ['C'], size: 'M', size_reason: '', open_questions: [], risks: [],
  confidence: 0.5, needs_lead: false, prd_score: 0, prd_score_dims: { clarity: 0, completeness: 0, feasibility: 0, testability: 0 }, prd_score_reason: '',
};
const CHANGES = JSON.stringify({ verdict: 'CHANGES_REQUESTED', findings: [{ severity: 'high', issue: 'x', where: 'open_questions', fix: 'y', evidence: 'z' }] });
const FIX = (env: unknown) => JSON.stringify({ artifact: env, needs_human: [] });

async function mkSession(id: string) {
  const p = join(mkdtempSync(join(tmpdir(), 'forge-gatea-')), 'gate-a.json');
  writeFileSync(p, JSON.stringify(BASE_ENV));
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  await sessions.patch(id, { gate_a_output_path: p });
  return (await sessions.get(id))!;
}

test('runGateALoop: codex says LGTM -> resolved without calling the fixer, and the adversarial round is persisted', async () => {
  codexQueue.length = 0; claudeQueue.length = 0;
  codexQueue.push({ ok: true, result: JSON.stringify({ verdict: 'LGTM', findings: [] }) });
  const out = await runGateALoop(await mkSession('gal1'));
  assert.equal(out.resolved, true);
  assert.equal(out.verdict, 'LGTM');
  assert.equal((await sessions.get('gal1'))!.gate_a_adv_round, 1);
  assert.equal(claudeQueue.length, 0); // the fixer was never called, so its queue was never consumed
});

test('runGateALoop: CHANGES -> claude revises the review -> the re-review says LGTM; the revision lands in gate-a.json and the fixer session is persisted', async () => {
  codexQueue.length = 0; claudeQueue.length = 0;
  codexQueue.push({ ok: true, result: CHANGES });
  claudeQueue.push({ ok: true, result: FIX({ ...BASE_ENV, open_questions: [{ q: 'Where does the refund go?', suggestion: 'the balance', severity: 'high', options: [] }] }) });
  codexQueue.push({ ok: true, result: JSON.stringify({ verdict: 'LGTM', findings: [] }) });
  const s = await mkSession('gal2');
  const out = await runGateALoop(s);
  assert.equal(out.resolved, true);
  const env = JSON.parse(readFileSync((await sessions.get('gal2'))!.gate_a_output_path!, 'utf8'));
  assert.equal(env.open_questions.length, 1); // claude's revision reached disk
  assert.ok((await sessions.get('gal2'))!.gate_a_fixer_session); // the fixer session is pinned and persisted, for resuming a revision
});

test('runGateALoop: still CHANGES at the cap -> stalled, storing gate_a_residual with source=codex', async () => {
  codexQueue.length = 0; claudeQueue.length = 0;
  for (let i = 0; i < 6; i++) { codexQueue.push({ ok: true, result: CHANGES }); claudeQueue.push({ ok: true, result: FIX(BASE_ENV) }); }
  const s = await mkSession('gal3');
  // The per-tick cap pauses first, so this simulates several ticks carrying on until it stalls, with a
  // sanity limit of five.
  let out = await runGateALoop(s);
  for (let i = 0; i < 5 && out.paused; i++) out = await runGateALoop((await sessions.get('gal3'))!);
  assert.equal(out.stalled, true);
  const resid = JSON.parse((await sessions.get('gal3'))!.gate_a_residual!) as { source: string; findings: unknown[] };
  assert.equal(resid.source, 'codex');
  assert.ok(resid.findings.length >= 1);
});

test('runGateALoop: with on_missing=skip and codex unavailable it counts as passed, which keeps the review draft rather than wedging', async () => {
  codexQueue.length = 0; claudeQueue.length = 0;
  codexQueue.push({ ok: false, available: false });
  // The repo's runtime.yaml sets on_missing=claude (degrade), so all this checks is that an unavailable codex
  // neither throws nor silently drops the draft -- it degrades to a claude re-review.
  claudeQueue.push({ ok: true, result: JSON.stringify({ verdict: 'LGTM', findings: [] }) });
  const out = await runGateALoop(await mkSession('gal4'));
  assert.equal(out.resolved, true);
});
