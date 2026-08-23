// Integration: the production path from the PRD source of truth into Gate B.
// Only the LLM, git fetch and target-project script boundaries are mocked; the real behaviour of runGateB,
// loadPrdTruth, the session store and the worker is exercised end to end.
process.env.FORGE_DB = ':memory:';

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const projectRoot = mkdtempSync(resolve(tmpdir(), 'forge-gateb-prdtruth-project-'));
process.env.FORGE_PROJECT_ROOT = projectRoot;

let claudeCalls = 0;
let lastPrompt = '';
let scaffoldCalls = 0;
const notifications: { kind: string; state: string; error?: string | null }[] = [];

const gateBResult = JSON.stringify({
  summary: 'design produced from the frozen PRD source of truth',
  key_decisions: { source: 'prd-truth' },
  tech_design_markdown: 'The implementation must rest only on the frozen source of truth and the source of truth in the code.',
  acceptance: {
    contracts: [{ repo: 'C', surface: 'POST /refund {order_id} -> 200 {refund_id}' }],
    scenarios: [{ id: 'AC1', repo: 'C', gherkin: 'Given a paid order\nWhen a refund is requested\nThen a refund id is returned' }],
  },
  issue_specs: [{ repo: 'C', title: 'feat(refund): support refunds', type: 'feat', prio: 'P1' }],
  confidence: 0.91,
});

mock.module('../src/gates/repoFreshness.ts', {
  namedExports: {
    refresh: (branch: string) => ({
      branch,
      fetchedAt: '2026-06-17T08:00:00.000Z',
      shas: { demo: 'abc123456789' },
      refsText: '- demo: `origin/dev` @ `abc123456789`',
    }),
    assertFresh: () => {},
  },
});
// The checkout anchor check is stubbed to "already aligned" - this test does not verify git, only runGateB's
// production behaviour.
mock.module('../src/gates/repoAnchor.ts', {
  namedExports: { anchorCheck: () => ({ off: [], disclosure: '' }), reposOffRef: () => [] },
});

mock.module('../src/llm/runClaude.ts', {
  namedExports: {
    runClaude: async (prompt: string) => {
      claudeCalls++;
      lastPrompt = prompt;
      return { ok: true, result: gateBResult, raw: gateBResult, costUsd: 0.12, sessionId: 'claude-gateb' };
    },
  },
});

mock.module('../src/workspace.ts', {
  namedExports: {
    commitDeliveryDocs: async () => ({ ok: true, committed: false, stderr: '' }),
    reviewReqScaffold: async () => ({ ok: true, stdout: '', stderr: '' }),
    techDesignScaffold: async () => {
      scaffoldCalls++;
      return { ok: true, stdout: '', stderr: '' };
    },
    techDesignApprove: async () => ({ ok: true, stdout: '', stderr: '' }),
    newReqSingle: async () => ({ ok: true, stdout: '', stderr: '', issues: [] }),
    newReqEpic: async () => ({ ok: true, stdout: '', stderr: '', issues: [] }),
    publishTechDesign: async () => ({ ok: true, stdout: '', stderr: '' }),
    listEpicChildren: async () => ({ ok: true, issues: [], stderr: '' }),
    issueStates: async () => [],
    addLabel: async () => ({ ok: true, stderr: '' }),
    prMergeState: async () => ({ ok: true, merged: true, state: 'MERGED' }),
  },
});

mock.module('../src/notify.ts', {
  namedExports: {
    notify: async (kind: string, s: { state: string; error?: string | null }) => {
      notifications.push({ kind, state: s.state, error: s.error ?? null });
    },
    syncGroupCard: async () => {},
  },
});

// The worker imports autoAssignOnGo; this keeps the success path from accidentally hitting the real load
// probe. The parking test never reaches it.
mock.module('../src/util/load.ts', {
  namedExports: { probeLoad: async () => [] },
});

const sessions = await import('../src/store/sessions.ts');
const { runGateB } = await import('../src/gates/gateB.ts');
const worker = await import('../src/orchestrator/worker.ts');

function deliveryDir(slug: string): string {
  return resolve(projectRoot, 'docs', 'delivery', slug);
}

async function createSession(id: string): ReturnType<typeof sessions.get> {
  await sessions.create({ id, slug: id, title: 'refund requirement', branch: 'dev', prd_url: 'https://feishu/prd' });
  return sessions.get(id);
}

async function moveToGateBRequested(id: string): Promise<void> {
  for (const st of ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED']) {
    await sessions.transition(id, st as never);
  }
}

beforeEach(() => {
  claudeCalls = 0;
  lastPrompt = '';
  scaffoldCalls = 0;
  notifications.length = 0;
});

test('production path: when the sealed prd-truth exists, Gate B reads only that frozen single source, and a gate-a.json that goes bad afterwards cannot pollute the prompt', async () => {
  const id = 'prdtruth-frozen-source';
  await createSession(id);
  mkdirSync(deliveryDir(id), { recursive: true });
  writeFileSync(
    resolve(deliveryDir(id), 'prd-truth.md'),
    [
      '# PRD source of truth (reviewed over several rounds)',
      'Frozen fact: this cycle ships store-credit refunds only.',
      'Final PM ruling: refunds to the original payment route are out of scope.',
    ].join('\n'),
  );
  const badGateA = resolve(mkdtempSync(resolve(tmpdir(), 'forge-bad-gatea-')), 'gate-a.json');
  writeFileSync(badGateA, '{"summary": "the old three sources must not be read again", "repos_');
  await sessions.patch(id, {
    gate_a_output_path: badGateA,
    confirmed_notes: 'the old confirmed_notes must not be spliced into Gate B as an independent input',
  });

  await runGateB((await sessions.get(id))!);

  assert.equal(claudeCalls, 1);
  assert.equal(scaffoldCalls, 1);
  assert.match(lastPrompt, /Frozen fact: this cycle ships store-credit refunds only/);
  assert.match(lastPrompt, /Final PM ruling: refunds to the original payment route are out of scope/);
  assert.doesNotMatch(lastPrompt, /the old three sources must not be read again/);
  assert.doesNotMatch(lastPrompt, /the old confirmed_notes must not be spliced into Gate B/);
  assert.doesNotMatch(lastPrompt, /\{\{PRD_TEXT\}\}|\{\{GATE_A_OUTPUT\}\}|\{\{CONFIRMED_NOTES\}\}/);
  assert.ok(readFileSync(resolve('logs', id, 'gate-b.prompt.txt'), 'utf8').includes('Frozen fact: this cycle ships store-credit refunds only'));
});

test('production path: when the sealed document is missing and gate-a.json is broken, the worker parks at GATE_B_FAILED and never calls claude to produce an empty-shell design', async () => {
  const id = 'prdtruth-bad-gatea-parks';
  await createSession(id);
  await moveToGateBRequested(id);
  const badGateA = resolve(mkdtempSync(resolve(tmpdir(), 'forge-bad-gatea-')), 'gate-a.json');
  writeFileSync(badGateA, '{"summary": "a truncated review draft"');
  await sessions.patch(id, { gate_a_output_path: badGateA, confirmed_notes: 'PM: confirmed' });

  await worker.step((await sessions.get(id))!);

  const parked = (await sessions.get(id))!;
  assert.equal(parked.state, 'GATE_B_FAILED');
  assert.match(parked.error ?? '', /PRD source of truth: the Gate A envelope failed to parse as JSON/);
  assert.equal(claudeCalls, 0);
  assert.equal(scaffoldCalls, 0);
  assert.ok(notifications.some((n) => n.kind === 'failed' && n.state === 'GATE_B_FAILED'));
});
