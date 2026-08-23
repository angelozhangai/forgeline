// Integration: the production chain of the assignment layer as a requirement is filed.
// Only the LLM, GitHub and main-repo script boundaries are mocked; worker.step -> autoAssignOnGo ->
// actions.go -> writes.doWrites all run for real.
process.env.FORGE_DB = ':memory:';

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const tmp = mkdtempSync(resolve(tmpdir(), 'forge-assignment-flow-'));
let seq = 0;
let loadRows: { code: string; wip: number; loadPoints: number; ok: boolean }[] = [];
let singleCreates = 0;
let lastSingleAssignee: string | null | undefined;
const notifications: { kind: string; state: string }[] = [];

function gateBDraftPath(slug: string): string {
  const p = resolve(tmp, `${slug}-${seq++}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      summary: 'the plan for refunding points',
      key_decisions: { owner: 'the DRI is assigned automatically' },
      tech_design_markdown: 'extend the existing points ledger to support refunds.',
      acceptance: {
        contracts: [{ repo: 'A', surface: 'POST /admin/refund {order_id, idem_key} -> 200 {refund_id}' }],
        scenarios: [{ id: 'AC1', repo: 'A', gherkin: 'Given a paid order\nWhen a refund is requested with an idempotency key\nThen a refund_id comes back and the order enters the refunding state' }],
      },
      issue_specs: [{ repo: 'A', title: 'feat(pay): support refunding points', type: 'feat', prio: 'P1' }],
      confidence: 0.88,
    }),
  );
  return p;
}

const sessionsRef: { mod?: typeof import('../src/store/sessions.ts') } = {};

mock.module('../src/gates/gateA.ts', {
  namedExports: {
    runGateA: async () => ({ round: 1, openQuestions: 0, resolved: true, stalled: false }),
    runGateARevision: async () => ({ round: 2, openQuestions: 0, resolved: true, stalled: false }),
  },
});

mock.module('../src/gates/gateB.ts', {
  namedExports: {
    runGateB: async (s: { id: string; slug: string }) => {
      sessionsRef.mod!.patch(s.id, { gate_b_draft_path: gateBDraftPath(s.slug), gate_b_round: 0, size: 'M' });
      return { summary: 'ok', key_decisions: {}, tech_design_markdown: '', issue_specs: [{ repo: 'A', title: 't' }], confidence: 0.8 };
    },
    finalizeGateBDoc: () => {},
  },
});

mock.module('../src/gates/gateBLoop.ts', {
  namedExports: {
    runGateBLoop: async () => ({ round: 1, verdict: 'clean', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] }),
  },
});

mock.module('../src/util/load.ts', {
  namedExports: {
    probeLoad: async () => loadRows,
  },
});

mock.module('../src/workspace.ts', {
  namedExports: {
    commitDeliveryDocs: async () => ({ ok: true, committed: false, stderr: '' }),
    publishTechDesign: async () => ({ ok: true, stdout: '', stderr: '' }),
    prMergeState: async () => ({ ok: true, merged: true, state: 'MERGED' }),
    newReqSingle: async (_repo: string, _title: string, o: { assignee?: string | null } = {}) => {
      singleCreates++;
      lastSingleAssignee = o.assignee;
      return { ok: true, stdout: 'created\n→ https://github.com/your-org/example-admin/issues/101', stderr: '', issues: [{ repo: 'example-admin', number: 101, url: 'https://github.com/your-org/example-admin/issues/101' }] };
    },
    newReqEpic: async () => ({ ok: false, stdout: '', stderr: 'unexpected epic path', issues: [] }),
    listEpicChildren: async () => ({ ok: true, issues: [], stderr: '' }),
    issueStates: async () => [],
    addLabel: async () => ({ ok: true, stderr: '' }),
    techDesignApprove: async () => ({ ok: true, stdout: 'status:3', stderr: '' }),
  },
});

mock.module('../src/notify.ts', {
  namedExports: {
    notify: async (kind: string, s: { state: string }) => {
      notifications.push({ kind, state: s.state });
    },
    syncGroupCard: async () => {},
  },
});

const sessions = await import('../src/store/sessions.ts');
sessionsRef.mod = sessions;
const worker = await import('../src/orchestrator/worker.ts');
const actions = await import('../src/actions.ts');

async function confirmedSession(slug: string): Promise<string> {
  await sessions.create({ id: slug, slug, title: 'the plan for refunding points', branch: 'dev' });
  for (const st of ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED']) {
    await sessions.transition(slug, st as never);
  }
  return slug;
}

beforeEach(() => {
  loadRows = [];
  singleCreates = 0;
  lastSingleAssignee = undefined;
  notifications.length = 0;
});

test('gate B passes -> a DRI is recommended automatically -> one press of go: new-req receives the recommended person as the GitHub assignee', async () => {
  loadRows = [
    { code: 'M', wip: 1, loadPoints: 8, ok: true },
    { code: 'EO', wip: 0, loadPoints: 1, ok: true },
    { code: 'CC', wip: 1, loadPoints: 5, ok: true },
    { code: 'DE', wip: 1, loadPoints: 6, ok: true },
  ];
  const slug = await confirmedSession('auto-dri-go');

  await worker.step((await sessions.get(slug))!);
  let s = (await sessions.get(slug))!;
  assert.equal(s.state, 'AWAITING_GO');
  assert.equal(s.assignee, 'EO');
  assert.equal(s.assignee_source, 'auto');
  assert.ok(notifications.some((n) => n.kind === 'needs_go' && n.state === 'AWAITING_GO'));

  const r = await actions.go(slug, 'M');
  s = (await sessions.get(slug))!;
  assert.equal(r.ok, true);
  assert.equal(s.state, 'DONE');
  assert.equal(singleCreates, 1);
  assert.equal(lastSingleAssignee, 'erin-ops');
});

test('gate B passes but every load probe fails: it is visible as awaiting go, but a requirement with no DRI cannot be created', async () => {
  loadRows = [
    { code: 'M', wip: 0, loadPoints: 0, ok: false },
    { code: 'EO', wip: 0, loadPoints: 0, ok: false },
    { code: 'CC', wip: 0, loadPoints: 0, ok: false },
    { code: 'DE', wip: 0, loadPoints: 0, ok: false },
  ];
  const slug = await confirmedSession('no-dri-blocks-go');

  await worker.step((await sessions.get(slug))!);
  let s = (await sessions.get(slug))!;
  assert.equal(s.state, 'AWAITING_GO');
  assert.equal(s.assignee, null);
  assert.ok(notifications.some((n) => n.kind === 'needs_go'));

  const r = await actions.go(slug, 'M');
  s = (await sessions.get(slug))!;
  assert.equal(r.ok, false);
  assert.match(r.msg, /no DRI is assigned/);
  assert.equal(s.state, 'AWAITING_GO');
  assert.equal(singleCreates, 0);
  assert.ok((await sessions.events(slug)).some((e) => e.kind === 'go_blocked_no_assignee'));
});
