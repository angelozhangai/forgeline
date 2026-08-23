// Integration: the permission gates and state transitions of Gate D's human actions (requestReviewPr, which
// triggers opening the PR, and submitGateDAnswers, which answers an escalation or arbitrates).
// It uses the real permissions.yaml (pr_create_approvers = [M]); the IM, write actions and load probe are
// mocked.
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
const { loadConfig } = await import('../src/config.ts'); // a dynamic import (never a static one! a static import hoists above FORGE_DB=':memory:', so root.ts would resolve the real database and concurrent tests would share it). The stub falls back to the real config.

mock.module('../src/notify.ts', { namedExports: { notify: async () => {}, syncGroupCard: async () => {} } });
mock.module('../src/writes.ts', { namedExports: { doWrites: async () => ({ ok: true, stdout: '', issues: [] }) } });
mock.module('../src/util/load.ts', { namedExports: { probeLoad: async () => [] } });
// repoPath returns a path per repo (a multi-repo ackMerged must clean up inside each repo's own repoDir; a
// single repo '.' keeps /proj/repo unchanged).
mock.module('../src/projects.ts', {
  namedExports: { projectForSession: () => ({ id: 'p', root: '/proj', repos: ['.'], repoPath: (r: string) => (r === '.' ? '/proj/repo' : `/proj/${r}`), deliveryDir: '/tmp', scripts: {} }), configForProject: () => loadConfig(), configForSession: () => loadConfig() },
});
// ackMerged cleans up the isolated worktree: mocked as a counting, argument-capturing no-op (so the multi-repo
// tests can assert the cleanup happened in each repo's own repoDir). No real git runs.
let removeCalls = 0;
let deleteCalls = 0;
let rmRepoDirs: string[] = [];
let delRepoDirs: string[] = [];
mock.module('../src/util/worktree.ts', {
  namedExports: {
    removeWorktree: async (o: { repoDir: string }) => { removeCalls++; rmRepoDirs.push(o.repoDir); return { ok: true, output: '' }; },
    deleteBranch: (repoDir: string) => { deleteCalls++; delRepoDirs.push(repoDir); },
  },
});
// Before acknowledging, ackMerged verifies through prMergeState -> gh pr view <url>. This test runs no real
// git, so proc is mocked to let gh return a switchable merge state.
// When ghStateByUrl is set, the state is returned per PR url (args[2]) - the multi-repo "partially merged"
// case; otherwise it falls back to the global ghMerged.
let ghMerged = true;
let ghStateByUrl: Record<string, string> | null = null;
mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (bin: string, args: string[]) => {
      if (bin === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        const state = ghStateByUrl ? (ghStateByUrl[args[2]] ?? 'OPEN') : ghMerged ? 'MERGED' : 'OPEN';
        return { code: 0, stdout: JSON.stringify({ state }), stderr: '', timedOut: false };
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    },
    runSync: () => '',
    commandExists: () => true,
  },
});

const sessions = await import('../src/store/sessions.ts');
const actions = await import('../src/actions.ts');
const { mkLeg } = await import('../src/gates/legs.ts');

let n = 0;
const toDone = ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE'];
const toAwaitD = [...toDone, 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'AWAITING_GATE_D'];
async function at(target: string): Promise<string> {
  const id = `d${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  const path: Record<string, string[]> = {
    AWAITING_GATE_D: toAwaitD,
    GATE_D_REQUESTED: [...toAwaitD, 'GATE_D_REQUESTED'],
    AWAITING_GATE_D_INPUT: [...toAwaitD, 'GATE_D_REQUESTED', 'GATE_D_LOOP', 'AWAITING_GATE_D_INPUT'],
    GATE_D_STALLED: [...toAwaitD, 'GATE_D_REQUESTED', 'GATE_D_LOOP', 'GATE_D_STALLED'],
    AWAITING_HUMAN_MERGE: [...toAwaitD, 'GATE_D_REQUESTED', 'GATE_D_LOOP', 'GATE_D_HARDENING', 'AWAITING_HUMAN_MERGE'],
    SHIPPED: [...toAwaitD, 'GATE_D_REQUESTED', 'GATE_D_LOOP', 'GATE_D_HARDENING', 'AWAITING_HUMAN_MERGE', 'SHIPPED'],
    DONE: toDone,
  };
  for (const st of path[target] ?? []) await sessions.transition(id, st as never);
  return id;
}

test('requestReviewPr: AWAITING_GATE_D + an authorised user (M) -> GATE_D_REQUESTED', async () => {
  const id = await at('AWAITING_GATE_D');
  const r = await actions.requestReviewPr(id, 'M');
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'GATE_D_REQUESTED');
  assert.equal((await sessions.get(id))!.gate_d_requested_by, 'M');
});

test('requestReviewPr: refused outside AWAITING_GATE_D (Gate C must be green first)', async () => {
  const id = await at('DONE');
  const r = await actions.requestReviewPr(id, 'M');
  assert.equal(r.ok, false);
  assert.match(r.msg, /AWAITING_GATE_D/);
  assert.equal((await sessions.get(id))!.state, 'DONE');
});

test('requestReviewPr: an unauthorised user is refused, the state does not change, and permission_denied is recorded', async () => {
  const id = await at('AWAITING_GATE_D');
  const r = await actions.requestReviewPr(id, 'ZZ');
  assert.equal(r.ok, false);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GATE_D');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'permission_denied'));
});

test('requestReviewPr: already at GATE_D_REQUESTED is idempotent and ok', async () => {
  const id = await at('GATE_D_REQUESTED');
  assert.ok((await actions.requestReviewPr(id, 'M')).ok);
});

test('submitGateDAnswers: AWAITING_GATE_D_INPUT -> GATE_D_REVISION_REQUESTED, with pending_input persisted', async () => {
  const id = await at('AWAITING_GATE_D_INPUT');
  const r = await actions.submitGateDAnswers(id, 'M', 'accept codex finding 2 and revise per option A');
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_D_REVISION_REQUESTED');
  assert.equal(s.gate_d_pending_input, 'accept codex finding 2 and revise per option A');
});

test('submitGateDAnswers: arbitrating a GATE_D_STALLED session resumes the revision; an empty answer still means one more round', async () => {
  const id = await at('GATE_D_STALLED');
  const r = await actions.submitGateDAnswers(id, 'M');
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'GATE_D_REVISION_REQUESTED');
});

test('submitGateDAnswers: refused in the wrong state or without permission', async () => {
  assert.equal((await actions.submitGateDAnswers(await at('AWAITING_GATE_D'), 'M')).ok, false); // not a state that accepts answers
  assert.equal((await actions.submitGateDAnswers(await at('AWAITING_GATE_D_INPUT'), 'ZZ')).ok, false); // no permission
});

test('ackMerged: AWAITING_HUMAN_MERGE + an authorised user (M) -> SHIPPED, and the worktree is cleaned up (nothing is ever merged automatically; this is a human acknowledgement)', async () => {
  removeCalls = 0; deleteCalls = 0;
  const id = await at('AWAITING_HUMAN_MERGE');
  await sessions.patch(id, { worktree_path: '/wt/x', impl_branch: 'forge/x', pr_url: 'https://x/pull/9' });
  const r = await actions.ackMerged(id, 'M');
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'SHIPPED');
  assert.equal(s.merged_by, 'M');
  assert.ok(s.merged_at);
  assert.equal(removeCalls, 1); // the isolated worktree is removed
  assert.equal(deleteCalls, 1); // the implementation branch is deleted
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'merged'));
});

test('ackMerged: gh reports the PR is not merged -> refuse, clean up nothing and never go SHIPPED (unknown or unmerged is never treated as merged)', async () => {
  removeCalls = 0; deleteCalls = 0;
  const id = await at('AWAITING_HUMAN_MERGE');
  await sessions.patch(id, { worktree_path: '/wt/x', impl_branch: 'forge/x', pr_url: 'https://x/pull/9' });
  ghMerged = false;
  const r = await actions.ackMerged(id, 'M');
  ghMerged = true; // restore the shared state
  assert.equal(r.ok, false);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_HUMAN_MERGE'); // the state does not move
  assert.equal(removeCalls, 0); // the irreversible cleanup never happens
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'merge_ack_refused'));
});

test('ackMerged: refused outside AWAITING_HUMAN_MERGE (it must reach merge-ready first)', async () => {
  const r = await actions.ackMerged(await at('AWAITING_GATE_D'), 'M');
  assert.equal(r.ok, false);
  assert.match(r.msg, /AWAITING_HUMAN_MERGE/);
});

test('ackMerged: an unauthorised user is refused, the state does not change, and permission_denied is recorded (the worktree is untouched)', async () => {
  removeCalls = 0;
  const id = await at('AWAITING_HUMAN_MERGE');
  const r = await actions.ackMerged(id, 'ZZ');
  assert.equal(r.ok, false);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_HUMAN_MERGE');
  assert.equal(removeCalls, 0); // the permission check runs before any cleanup
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'permission_denied'));
});

test('ackMerged: already SHIPPED is idempotent and ok', async () => {
  assert.ok((await actions.ackMerged(await at('SHIPPED'), 'M')).ok);
});

// -- Multi-repo "one repo, one tree, one PR": ackMerged verifies each leg's own PR, and only once they are all
//    merged does it clean up every leg's worktree and go SHIPPED --
async function awaitMergeWithLegs(legs: { repo: string; pr: string }[]): Promise<string> {
  const id = await at('AWAITING_HUMAN_MERGE');
  await sessions.patch(id, {
    legs: JSON.stringify(legs.map((l) => mkLeg(l.repo, { worktree_path: `/wt/${l.repo}`, impl_branch: 'forge/k', pr_url: l.pr, gate_d_harden_verified_sha: 'V' }))),
  });
  return id;
}

test('ackMerged (multi-repo): every leg\'s PR is merged -> SHIPPED, each repo\'s worktree cleaned up inside its own repoDir, and each leg marked merged', async () => {
  removeCalls = 0; deleteCalls = 0; rmRepoDirs = []; delRepoDirs = [];
  ghStateByUrl = { 'https://x/pull/11': 'MERGED', 'https://x/pull/22': 'MERGED' };
  const id = await awaitMergeWithLegs([{ repo: 'demo', pr: 'https://x/pull/11' }, { repo: 'example-web', pr: 'https://x/pull/22' }]);
  const r = await actions.ackMerged(id, 'M');
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'SHIPPED');
  assert.equal(removeCalls, 2); // one cleanup per leg
  assert.deepEqual(rmRepoDirs.slice().sort(), ['/proj/demo', '/proj/example-web']); // each inside its own repo
  assert.deepEqual(delRepoDirs.slice().sort(), ['/proj/demo', '/proj/example-web']);
  const ls = JSON.parse((await sessions.get(id))!.legs!) as { merged: boolean }[];
  assert.ok(ls.every((l) => l.merged === true)); // each leg is marked merged
  ghStateByUrl = null; // restore the shared state
});

test('ackMerged (multi-repo): any leg\'s PR still unmerged -> refuse, clean up nothing and never go SHIPPED (the red line: the whole session is never declared shipped while a leg is unmerged)', async () => {
  removeCalls = 0;
  ghStateByUrl = { 'https://x/pull/11': 'MERGED', 'https://x/pull/22': 'OPEN' }; // example-web is not merged
  const id = await awaitMergeWithLegs([{ repo: 'demo', pr: 'https://x/pull/11' }, { repo: 'example-web', pr: 'https://x/pull/22' }]);
  const r = await actions.ackMerged(id, 'M');
  assert.equal(r.ok, false);
  assert.match(r.msg, /example-web/);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_HUMAN_MERGE'); // the state does not move
  assert.equal(removeCalls, 0); // nothing is cleaned up (the irreversible action never happened)
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'merge_ack_refused'));
  ghStateByUrl = null;
});

test('ackMerged --force (multi-repo): a human can override a partial merge -> SHIPPED, with a forced audit event', async () => {
  removeCalls = 0;
  ghStateByUrl = { 'https://x/pull/11': 'MERGED', 'https://x/pull/22': 'OPEN' };
  const id = await awaitMergeWithLegs([{ repo: 'demo', pr: 'https://x/pull/11' }, { repo: 'example-web', pr: 'https://x/pull/22' }]);
  assert.equal((await actions.ackMerged(id, 'M')).ok, false, 'without --force it is refused');
  const r = await actions.ackMerged(id, 'M', { force: true });
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'SHIPPED');
  assert.equal(removeCalls, 2);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'merge_ack_forced'));
  ghStateByUrl = null;
});
