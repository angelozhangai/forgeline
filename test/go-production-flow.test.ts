// Integration: the production consequences of a multi-repo write, driven from the real action entry point
// (forge go).
// Only the GitHub and main-repo script boundaries are mocked; the state machine, actions.go, writes.doWrites
// and persisting the session all run for real.
process.env.FORGE_DB = ':memory:';

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

let epicCreates = 0;
let approveCalls = 0;
let labelCalls = 0;
let epicMissExampleChild = false;
let discoveredByRepo: Record<string, { number: number; url: string }[]> = {};
const notifications: { kind: string; state: string; issues?: unknown }[] = [];

function epicStdout(): string {
  const lines = [
    '=== creating the multi-repo requirement Epic epic:refund-flow: the refund plan ===',
    '  ✓ Epic P#10  status=status:1-under-discussion',
    '  -- child issues --',
    '    ✓ C#11  feat(api): the refund endpoint',
  ];
  if (!epicMissExampleChild) lines.push('    ✓ U#12  feat(web): the refund entry point');
  lines.push('  → Epic: https://github.com/your-org/example-project/issues/10');
  return lines.join('\n');
}

mock.module('../src/workspace.ts', {
  namedExports: {
    commitDeliveryDocs: async () => ({ ok: true, committed: false, stderr: '' }),
    publishTechDesign: async () => ({ ok: true, stdout: '', stderr: '' }),
    prMergeState: async () => ({ ok: true, merged: true, state: 'MERGED' }),
    newReqSingle: async () => ({ ok: false, stdout: '', stderr: 'unexpected single path', issues: [] }),
    newReqEpic: async () => {
      epicCreates++;
      return {
        ok: true,
        stdout: epicStdout(),
        stderr: '',
        issues: [{ repo: 'example-project', number: 10, url: 'https://github.com/your-org/example-project/issues/10' }],
      };
    },
    listEpicChildren: async (repo: string) => ({
      ok: true,
      issues: (discoveredByRepo[repo] ?? []).map((i) => ({ repo, number: i.number, url: i.url })),
      stderr: '',
    }),
    addLabel: async () => {
      labelCalls++;
      return { ok: true, stderr: '' };
    },
    techDesignApprove: async () => {
      approveCalls++;
      return { ok: true, stdout: 'status:3', stderr: '' };
    },
  },
});

mock.module('../src/notify.ts', {
  namedExports: {
    notify: async (kind: string, s: { state: string }, extra?: { issues?: unknown }) => {
      notifications.push({ kind, state: s.state, issues: extra?.issues });
    },
    syncGroupCard: async () => {},
  },
});

const sessions = await import('../src/store/sessions.ts');
const actions = await import('../src/actions.ts');

const tmp = mkdtempSync(resolve(tmpdir(), 'forge-go-flow-'));
let seq = 0;

const multiRepoDraft = {
  summary: 'the refund plan',
  key_decisions: { rollout: 'backend first' },
  tech_design_markdown: 'the back end goes first, and the front end wires in afterwards.',
  multi_repo: true,
  epic_title: '[Epic] refund support',
  issue_specs: [
    { repo: 'C', title: 'feat(api): the refund endpoint', type: 'feat', prio: 'P1' },
    { repo: 'U', title: 'feat(web): the refund entry point', type: 'feat', prio: 'P1' },
  ],
  acceptance: {
    contracts: [{ repo: '', surface: 'POST /api/v1/refunds {order_id, idem_key} -> 200 {refund_id}' }],
    scenarios: [{ id: 'AC1', repo: '', gherkin: 'Given a paid order\nWhen a refund is requested with an idempotency key\nThen a refund number comes back and the order enters the refunding state' }],
  },
  confidence: 0.88,
};

function draftPath(env = multiRepoDraft): string {
  const p = resolve(tmp, `gate-b-${seq++}.json`);
  writeFileSync(p, JSON.stringify(env));
  return p;
}

async function sessionAwaitingGo(slug: string): Promise<string> {
  await sessions.create({ id: slug, slug, title: 'the refund plan', branch: 'dev' });
  for (const st of ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO']) {
    await sessions.transition(slug, st as never);
  }
  await sessions.patch(slug, { gate_b_draft_path: draftPath(), size: 'M', assignee: 'M' }); // filing the work needs a DRI (the assignment gate)
  return slug;
}

async function issueRepos(slug: string): Promise<string[]> {
  return JSON.parse((await sessions.get(slug))!.created_issues ?? '[]').map((i: { repo: string }) => i.repo).sort();
}

beforeEach(() => {
  epicCreates = 0;
  approveCalls = 0;
  labelCalls = 0;
  epicMissExampleChild = false;
  discoveredByRepo = {};
  notifications.length = 0;
});

test('the go production flow: a partly failed multi-repo creation parks at WRITE_FAILED, and only once a child is added by hand does a retry reach DONE -- without creating the Epic a second time', async () => {
  const slug = await sessionAwaitingGo('refund-flow');
  epicMissExampleChild = true;

  const first = await actions.go(slug, 'M');
  assert.equal(first.ok, false);
  assert.match(first.msg, /sub-issues are missing/);
  assert.equal((await sessions.get(slug))!.state, 'WRITE_FAILED');
  assert.deepEqual(await issueRepos(slug), ['demo', 'example-project']);
  assert.equal(epicCreates, 1);
  assert.equal(approveCalls, 0);
  assert.ok(notifications.some((n) => n.kind === 'failed' && n.state === 'WRITE_FAILED'));

  const stillMissing = await actions.go(slug, 'M');
  assert.equal(stillMissing.ok, false);
  assert.equal((await sessions.get(slug))!.state, 'WRITE_FAILED');
  assert.deepEqual(await issueRepos(slug), ['demo', 'example-project']);
  assert.equal(epicCreates, 1, 'retry must not create a second Epic');
  assert.equal(approveCalls, 0);

  discoveredByRepo = {
    'example-web': [{ number: 12, url: 'https://github.com/your-org/example-web/issues/12' }],
  };
  const repaired = await actions.go(slug, 'M');
  assert.equal(repaired.ok, true);
  assert.match(repaired.msg, /DONE|created/);
  assert.equal((await sessions.get(slug))!.state, 'DONE');
  assert.deepEqual(await issueRepos(slug), ['demo', 'example-project', 'example-web']);
  assert.equal(epicCreates, 1, 'manual add-child repair must be discovered, not recreated');
  assert.equal(approveCalls, 1);
  assert.equal(labelCalls, 1, 'multi-repo size label is applied to the Epic demand row');
  assert.ok(notifications.some((n) => n.kind === 'done' && n.state === 'DONE'));
});

