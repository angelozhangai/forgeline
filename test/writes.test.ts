// Unit tests: doWrites is idempotent when it writes the requirement node (P1-D), and it never fails
// silently -- a failed approve, a failed label, or a partly created set of sub-issues all throw and park as
// WRITE_FAILED.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// workspace creating issues, labels and the release: counted, with injectable failures that behave like the
// real bash() wrapper -- it returns {ok:false} rather than throwing.
let singleCalls = 0;
let epicCalls = 0;
let approveCalls = 0;
let labelCalls = 0;
let approveOk = true;
let labelOk = true;
let epicMissChild = false; // true -> the epic output is missing one sub-issue marker (simulating a child that failed to create and was skipped)
let epicChildrenByRepo: Record<string, { number: number; url: string }[]> = {}; // what listEpicChildren returns per repo (simulating a child added by hand afterwards)
let listChildrenCalls = 0;
let lastSingleAssignee: string | null | undefined; // captures the assignee passed when creating the issue (to check the session DRI override)
let lastEpicAssignee: string | null | undefined;
let publishCalls = 0; // F3: publishing the tech design to the main repo, which has to happen before any issue is created
let lastPublishDryRun: boolean | undefined;
let publishFail = false;
const callOrder: string[] = []; // to assert the publish -> newReq order

// What new-req.sh really prints for an epic: each sub-issue is only `✓ C#n` with no full URL, and only the
// Epic gets one. The heading is reproduced as an escape because the target project's script prints it in its
// own language -- this repo's source is English, but the output it parses is data.
function epicStdout(): string {
  const lines = ['═══ Epic ═══', '  ✓ Epic P#10', '  ── \u5b50 issue ──', '    ✓ C#11  c'];
  if (!epicMissChild) lines.push('    ✓ U#12  u');
  lines.push('  → Epic: https://github.com/your-org/example-project/issues/10');
  return lines.join('\n');
}

mock.module('../src/workspace.ts', {
  namedExports: {
    commitDeliveryDocs: async () => ({ ok: true, committed: false, stderr: '' }),
    publishTechDesign: async (_slug: string, o: { base: string; dryRun?: boolean }) => {
      publishCalls++;
      lastPublishDryRun = o.dryRun;
      callOrder.push('publish');
      return { ok: !publishFail, stdout: '', stderr: publishFail ? 'publish boom' : '' };
    },
    newReqSingle: async (_repo: string, _title: string, o: { assignee?: string | null } = {}) => {
      singleCalls++;
      lastSingleAssignee = o.assignee;
      callOrder.push('single');
      return { ok: true, stdout: 'created\n→ https://github.com/your-org/example-admin/issues/1', stderr: '', issues: [{ repo: 'example-admin', number: 1, url: 'https://github.com/your-org/example-admin/issues/1' }] };
    },
    newReqEpic: async (_slug: string, _title: string, _children: unknown[], o: { assignee?: string | null } = {}) => {
      epicCalls++;
      lastEpicAssignee = o.assignee;
      callOrder.push('epic');
      // The real wrapper's issues come from parseIssues(stdout), so they cover the Epic only (the children have no URL).
      return { ok: true, stdout: epicStdout(), stderr: '', issues: [{ repo: 'example-project', number: 10, url: 'https://github.com/your-org/example-project/issues/10' }] };
    },
    techDesignApprove: async () => {
      approveCalls++;
      return { ok: approveOk, stdout: '', stderr: approveOk ? '' : 'approve exited non-zero' };
    },
    addLabel: async () => {
      labelCalls++;
      return { ok: labelOk, stderr: labelOk ? '' : 'the label did not sync' };
    },
    listEpicChildren: async (repo: string) => {
      listChildrenCalls++;
      return { ok: true, issues: (epicChildrenByRepo[repo] ?? []).map((x) => ({ repo, number: x.number, url: x.url })), stderr: '' };
    },
  },
});

const { doWrites } = await import('../src/writes.ts');

const DIR = mkdtempSync(resolve(tmpdir(), 'forge-writes-'));
let seq = 0;
function draft(env: unknown): string {
  const p = resolve(DIR, `draft-${seq++}.json`);
  writeFileSync(p, JSON.stringify(env));
  return p;
}
// biome-ignore lint/suspicious/noExplicitAny: a test fixture -- any is deliberate, to build partial sessions of any shape
function sess(over: Record<string, unknown>): any {
  return { id: 'x', ref_num: 1, slug: 'feat-x', title: 'T', prd_url: null, size: 'M', created_issues: null, ...over };
}
const SINGLE = { issue_specs: [{ repo: 'A', title: 't' }], multi_repo: false };
const MULTI = { multi_repo: true, epic_title: 'E', issue_specs: [{ repo: 'C', title: 'c' }, { repo: 'U', title: 'u' }] };

beforeEach(() => {
  singleCalls = 0; epicCalls = 0; approveCalls = 0; labelCalls = 0; listChildrenCalls = 0;
  approveOk = true; labelOk = true; epicMissChild = false; epicChildrenByRepo = {};
  lastSingleAssignee = undefined; lastEpicAssignee = undefined;
  publishCalls = 0; lastPublishDryRun = undefined; publishFail = false; callOrder.length = 0;
});

// -- F3: publish the tech design to the main repo first, then create the issues --
test('publish happens before any issue is created (a real run)', async () => {
  await doWrites(sess({ gate_b_draft_path: draft(SINGLE) }));
  assert.equal(publishCalls, 1);
  assert.deepEqual(callOrder, ['publish', 'single']); // publish first, create second
  assert.equal(lastPublishDryRun, undefined); // a real run, not a dry one
});

test('a failed publish throws and parks as WRITE_FAILED, and no issue is ever created', async () => {
  publishFail = true;
  await assert.rejects(() => doWrites(sess({ gate_b_draft_path: draft(SINGLE) })), /publishing the technical plan to the main repo failed/);
  assert.equal(singleCalls, 0); // the publish did not land, so nothing is created
});

test('dryRun makes publish pass --dry-run, so nothing is really published', async () => {
  await doWrites(sess({ gate_b_draft_path: draft(SINGLE) }), { dryRun: true });
  assert.equal(lastPublishDryRun, true);
});

// -- The session DRI override: the assignment layer sets the issue assignee, with short codes resolved
// through resolveLogin --
test('the session assignee overrides a single-repo issue\'s assignee (short code -> login)', async () => {
  await doWrites(sess({ assignee: 'DE', gate_b_draft_path: draft(SINGLE) }));
  assert.equal(lastSingleAssignee, 'dave-eng'); // DE -> the login
});

test('the session assignee overrides the Epic\'s DRI, beating issue_spec.assignee', async () => {
  await doWrites(sess({ assignee: 'CC', gate_b_draft_path: draft({ ...MULTI, issue_specs: [{ repo: 'C', title: 'c', assignee: 'EO' }, { repo: 'U', title: 'u' }] }) }));
  assert.equal(lastEpicAssignee, 'carol-codes'); // the session's CC beats the spec's EO
});

test('with no session assignee it falls back to issue_spec.assignee (the existing behaviour is untouched)', async () => {
  await doWrites(sess({ gate_b_draft_path: draft({ issue_specs: [{ repo: 'A', title: 't', assignee: 'bob-dev' }], multi_repo: false }) }));
  assert.equal(lastSingleAssignee, 'bob-dev');
});

// -- Idempotence (P1-D) --
test('a single repo, first time: one issue created, onCreated persists it, and labels and approve both run', async () => {
  const created: unknown[] = [];
  const r = await doWrites(sess({ gate_b_draft_path: draft(SINGLE) }), { onCreated: (iss) => created.push(...iss) });
  assert.equal(singleCalls, 1);
  assert.equal(approveCalls, 1);
  assert.equal(r.issues.length, 1);
  assert.equal(created.length, 1);
});

test('a single repo, on retry (created_issues already populated): skip the creation and only re-run labels and approve', async () => {
  const _r = await doWrites(sess({
    gate_b_draft_path: draft(SINGLE),
    created_issues: JSON.stringify([{ repo: 'example-admin', number: 1, url: 'http://x/1' }]),
  }), {});
  assert.equal(singleCalls, 0);
  assert.equal(approveCalls, 1);
  assert.equal(labelCalls, 1);
});

test('several repos, first time: one Epic created, with the Epic and its children persisted; a retry skips the creation', async () => {
  const created: CreatedIssueT[] = [];
  await doWrites(sess({ gate_b_draft_path: draft(MULTI) }), { onCreated: (iss) => created.push(...iss) });
  assert.equal(epicCalls, 1);
  assert.equal(created.length, 3); // the Epic plus 2 children, parsed out of the ✓ C#/U# markers
  assert.deepEqual(created.map((c) => c.repo).sort(), ['demo', 'example-project', 'example-web']);

  epicCalls = 0;
  const r = await doWrites(sess({
    gate_b_draft_path: draft(MULTI),
    created_issues: JSON.stringify([{ repo: 'example-project', number: 10, url: 'http://x/10' }, { repo: 'demo', number: 11, url: 'http://x/11' }, { repo: 'example-web', number: 12, url: 'http://x/12' }]),
  }), {});
  assert.equal(epicCalls, 0);
  assert.equal(r.issues.length, 3);
});

test('dryRun always rehearses the whole thing -- even with created_issues populated it is not treated as a retry to skip', async () => {
  await doWrites(sess({
    gate_b_draft_path: draft(SINGLE),
    created_issues: JSON.stringify([{ repo: 'example-admin', number: 1, url: 'http://x/1' }]),
  }), { dryRun: true });
  assert.equal(singleCalls, 1);
  assert.equal(approveCalls, 0);
});

// -- Failures are never silent (findings 1, 2 and 3 from the review) --
test('finding 1: approve exits non-zero (returning {ok:false} rather than throwing) -> doWrites throws -> WRITE_FAILED, with onCreated already persisted', async () => {
  approveOk = false;
  const created: unknown[] = [];
  await assert.rejects(() => doWrites(sess({ gate_b_draft_path: draft(SINGLE) }), { onCreated: (iss) => created.push(...iss) }), /approve/);
  assert.equal(singleCalls, 1);
  assert.equal(created.length, 1); // persisted before the throw, so a retry does not create it again
});

test('finding 2: some children fail to create while the script still exits 0 -> the coverage check throws, and whatever was created stays in created_issues', async () => {
  epicMissChild = true; // U was never created
  const created: CreatedIssueT[] = [];
  await assert.rejects(
    () => doWrites(sess({ gate_b_draft_path: draft(MULTI) }), { onCreated: (iss) => { created.length = 0; created.push(...iss); } }),
    /sub-issues are missing/,
  );
  assert.equal(listChildrenCalls, 0); // the fresh path does not query GitHub -- it goes by the stdout markers and blocks straight away
  assert.equal(approveCalls, 0); // a missing child means status:3 is not released
  assert.deepEqual(created.map((c) => c.repo).sort(), ['demo', 'example-project']); // the Epic and C persisted; U is missing
});

test('finding 3: a failed size label throws and parks as WRITE_FAILED (never silently skewing the weekly-load numbers), and does not approve', async () => {
  labelOk = false;
  await assert.rejects(() => doWrites(sess({ gate_b_draft_path: draft(SINGLE) }), {}), /size label\(s\) failed/);
  assert.equal(approveCalls, 0); // the label fails before approve, so nothing is released
});

// -- A review finding: the resume path checks multi-repo coverage too, closing the "blocked the first time,
// slipped into DONE on the re-run" side door --
test('several repos, on retry: created_issues is still missing a repo and GitHub has not filled it in -> still throws WRITE_FAILED, and does not approve', async () => {
  // The previous round failed partway and left the Epic plus C, with U missing. Querying GitHub for
  // example-web finds nothing either -- nobody added it by hand.
  const s = sess({
    gate_b_draft_path: draft(MULTI),
    created_issues: JSON.stringify([{ repo: 'example-project', number: 10, url: 'http://x/10' }, { repo: 'demo', number: 11, url: 'http://x/11' }]),
  });
  await assert.rejects(() => doWrites(s, {}), /sub-issues are missing/);
  assert.equal(epicCalls, 0); // nothing is created again
  assert.equal(listChildrenCalls, 1); // it does try to rediscover the missing repo from GitHub
  assert.equal(approveCalls, 0); // a missing child means status:3 is not released
});

test('several repos, on retry: once someone adds the child by hand it is rediscovered by the epic label, created_issues is refreshed, and it approves through to DONE', async () => {
  epicChildrenByRepo = { 'example-web': [{ number: 12, url: 'http://x/12' }] }; // U was added by hand
  const created: CreatedIssueT[] = [];
  const s = sess({
    gate_b_draft_path: draft(MULTI),
    created_issues: JSON.stringify([{ repo: 'example-project', number: 10, url: 'http://x/10' }, { repo: 'demo', number: 11, url: 'http://x/11' }]),
  });
  const r = await doWrites(s, { onCreated: (iss) => { created.length = 0; created.push(...iss); } });
  assert.equal(epicCalls, 0); // nothing is created again
  assert.equal(listChildrenCalls, 1); // it queries example-web
  assert.equal(approveCalls, 1); // the coverage is complete -> released
  assert.equal(r.issues.length, 3); // the Epic, C, and the U that was filled in
  assert.deepEqual(created.map((c) => c.repo).sort(), ['demo', 'example-project', 'example-web']); // persisted again, refreshed
});

// A small type helper, so `any` does not spread through the file
interface CreatedIssueT { repo: string; number: number; url: string }
