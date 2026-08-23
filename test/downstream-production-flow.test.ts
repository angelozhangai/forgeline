// Integration, at no cost: a **regression over how the downstream orchestration is wired together** --
// DONE -> (implement) -> gate C green -> (review-pr) -> open the PR -> gate D LGTM -> hardening ->
// AWAITING_HUMAN_MERGE -> (merged) -> SHIPPED. actions, worker.step, the state machine, sessions and notify
// all run for real, while **every gate's driver is mocked wholesale** (setting up the tree, the
// implement/CI loop, opening the PR, reviewing the diff, hardening). What is under test is how those pieces
// are strung together: the state gates, the afterGateC / afterGateD / runGateDHardenStep transitions, the
// green_sha pin, the worktree-cleanup wiring, the notifications, the event trail, and the red lines.
// It deliberately does **not** cover real CI, delegating a real PR, a real diff review, "only push when CI is
// green", or report generation -- those are each driver's own invariants, covered pointwise by
// gateDLoop.test / gateDHarden.test / gateC-setup.test, with the real chain backed by a manual smoke test
// that costs money. This is a wiring smoke test, not a replacement for those.
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
const { loadConfig } = await import('../src/config.ts'); // imported dynamically -- never statically! A static import hoists above FORGE_DB=':memory:', so root.ts lands on the real database and concurrent tests collide. The stub falls back to the real config.

const notifyCalls: string[] = [];
const sessionsRef: { mod?: typeof import('../src/store/sessions.ts') } = {};
mock.module('../src/notify.ts', { namedExports: { notify: async (k: string) => { notifyCalls.push(k); }, syncGroupCard: async () => {} } });

// The upstream gates are not exercised by this flow, but worker.ts imports them at module level -> no-op mocks.
mock.module('../src/gates/gateA.ts', { namedExports: { runGateA: async () => ({ round: 1, openQuestions: 0, resolved: true, stalled: false }), runGateARevision: async () => ({ round: 1, openQuestions: 0, resolved: true, stalled: false }) } });
mock.module('../src/gates/gateB.ts', { namedExports: { runGateB: async () => ({}), finalizeGateBDoc: () => {} } });
mock.module('../src/gates/gateBLoop.ts', { namedExports: { runGateBLoop: async () => ({ round: 1, verdict: 'clean', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] }) } });
mock.module('../src/gates/gateALoop.ts', { namedExports: { runGateALoop: async () => ({ round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] }), readGateAEnvelope: () => ({ summary: 's', open_questions: [], risks: [] }) } });
mock.module('../src/util/load.ts', { namedExports: { probeLoad: async () => [] } });

// -- Mocks for the downstream drivers, reproducing the side effects the real gates leave behind: the
// worktree, the PR, the green sha, and the report --
mock.module('../src/gates/gateC.ts', {
  namedExports: {
    runGateCSetup: async (s: { id: string }) => { sessionsRef.mod!.patch(s.id, { worktree_path: '/wt/x', impl_branch: 'forge/x', base_shas: JSON.stringify({ '.': 'BASESHA' }) }); },
    // This flow takes the older single-repo path (setup records no legs, so afterGateC goes straight to
    // AWAITING_GATE_D); switching between legs is covered by the worker/gateC integration tests.
    activateLeg: () => {},
    activeLeg: () => null,
  },
});
const RESOLVED = { round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
mock.module('../src/gates/gateCLoop.ts', { namedExports: { runGateCLoop: async () => RESOLVED } });
mock.module('../src/gates/gateD.ts', { namedExports: { openReviewPr: async (s: { id: string }) => { sessionsRef.mod!.patch(s.id, { pr_url: 'https://x/pull/7', pr_number: 7 }); } } });
mock.module('../src/gates/gateDLoop.ts', { namedExports: { runGateDLoop: async () => RESOLVED, MAX_CI_FIX_ATTEMPTS: 2 } });
mock.module('../src/gates/gateDHarden.ts', { namedExports: { runGateDHarden: async (s: { id: string }) => { sessionsRef.mod!.patch(s.id, { gate_d_harden_round: 1, merge_readiness_path: '/wt/delivery/x/merge-readiness.md' }); } } });
// Worktree cleanup is mocked with a counter and captured arguments, so the test can assert that ackMerged
// really passes the right path, branch and repoDir to the cleanup -- not merely that an event was recorded.
let rmArg: { repoDir?: string; path?: string; removeScript?: string } | null = null;
let delArg: { repoDir: string; branch: string } | null = null;
mock.module('../src/util/worktree.ts', {
  namedExports: {
    worktreeHeadSha: () => 'GREENSHA',
    removeWorktree: async (o: { repoDir: string; path: string; removeScript?: string }) => { rmArg = o; return { ok: true, output: '' }; },
    deleteBranch: (repoDir: string, branch: string) => { delArg = { repoDir, branch }; },
    listWorktrees: () => [], // the orphan sweep lists nothing, so it is a no-op (this test does not cover sweeping)
    planWorktreeSweep: () => [],
  },
});
const projStub = { id: 'p', root: '/proj', repos: ['.'], repoPath: () => '/proj/repo', deliveryDir: '/tmp', scripts: {} };
mock.module('../src/projects.ts', { namedExports: { projectForSession: () => projStub, project: () => projStub, defaultProjectId: () => 'p', configForProject: () => loadConfig(), configForSession: () => loadConfig() } });
// Before it does anything, ackMerged verifies the merge through workspace.prMergeState -> gh pr view. All of
// proc is mocked (only three exports, which is sturdier than partially mocking workspace -- a partial mock
// there makes static imports like issueStates fail at load time). Flipping prMerged covers "not merged ->
// refuse" and "--force overrides".
let prMerged = true;
mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (bin: string, args: string[]) => {
      if (bin === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return { code: 0, stdout: JSON.stringify({ state: prMerged ? 'MERGED' : 'OPEN' }), stderr: '', timedOut: false };
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    },
    runSync: () => '',
    commandExists: () => true,
  },
});

const sessions = await import('../src/store/sessions.ts');
sessionsRef.mod = sessions;
const worker = await import('../src/orchestrator/worker.ts');
const actions = await import('../src/actions.ts');

async function mkDone(id: string): Promise<void> {
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  for (const st of ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE']) {
    await sessions.transition(id, st as never);
  }
}

test('the downstream production flow: DONE -> gate C green -> open the PR -> gate D LGTM -> hardening -> AWAITING_HUMAN_MERGE -> merged -> SHIPPED (never merging automatically)', async () => {
  notifyCalls.length = 0;
  const id = 'dpf';
  await mkDone(id);

  // 1) implement, chained -> GATE_C_REQUESTED
  assert.ok((await actions.requestGateC(id, 'M')).ok);
  assert.equal((await sessions.get(id))!.state, 'GATE_C_REQUESTED');

  // 2) a tick: build the worktree, run the implement/CI loop to green -> AWAITING_GATE_D, waiting to open the PR
  await worker.step((await sessions.get(id))!);
  let s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_GATE_D');
  assert.equal(s.worktree_path, '/wt/x'); // gate C built the isolated tree
  assert.ok(notifyCalls.includes('needs_review_pr'));

  // 3) review-pr -> GATE_D_REQUESTED
  assert.ok((await actions.requestReviewPr(id, 'M')).ok);
  assert.equal((await sessions.get(id))!.state, 'GATE_D_REQUESTED');

  // 4) a tick: open the PR -> gate D's codex-reviews-the-diff / claude-revises loop reaches LGTM -> on to
  //    hardening, pinning the green sha
  await worker.step((await sessions.get(id))!);
  s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_D_HARDENING');
  assert.equal(s.pr_url, 'https://x/pull/7'); // the PR was opened
  assert.equal(s.gate_d_green_sha, 'GREENSHA'); // the green state codex signed off on is pinned, as the hardening baseline

  // 5) a tick: hardening (add the inner-loop tests, get CI green, produce merge-readiness) -> ready to merge,
  //    and **stopping there for a human**
  await worker.step((await sessions.get(id))!);
  s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_HUMAN_MERGE'); // the red line: never merge automatically
  assert.equal(s.merge_readiness_path, '/wt/delivery/x/merge-readiness.md');
  assert.ok(notifyCalls.includes('needs_merge'));

  // 6a) The verification red line: the PR is not actually merged -> refuse, clean up nothing, and never
  //     reach SHIPPED. Unreadable or unmerged is never treated as merged.
  prMerged = false;
  const refuse = await actions.ackMerged(id, 'M');
  assert.equal(refuse.ok, false, 'the PR is not merged -> ackMerged refuses');
  assert.equal((await sessions.get(id))!.state, 'AWAITING_HUMAN_MERGE', 'the state does not move after a refusal');
  assert.equal(rmArg, null, 'a refusal never cleans up the worktree -- the irreversible action did not happen');
  assert.ok((await sessions.events(id)).map((e) => e.kind).includes('merge_ack_refused'));

  // 6b) merged: a human confirms it landed and gh agrees -> SHIPPED, and the isolated worktree is cleaned up.
  //     The red line: SHIPPED is reachable only through ackMerged, never automatically.
  prMerged = true;
  const r = await actions.ackMerged(id, 'M');
  assert.ok(r.ok);
  s = (await sessions.get(id))!;
  assert.equal(s.state, 'SHIPPED');
  assert.equal(s.merged_by, 'M');
  assert.ok(s.merged_at);
  // The cleanup wiring: ackMerged passes the right path, branch and repoDir to the delegated cleanup -- this
  // checks more than the worktree_cleaned event.
  assert.deepEqual(rmArg, { repoDir: '/proj/repo', path: '/wt/x', removeScript: undefined });
  assert.deepEqual(delArg, { repoDir: '/proj/repo', branch: 'forge/x' });

  // The event trail is complete end to end, and the final state is right.
  const kinds = (await sessions.events(id)).map((e) => e.kind);
  for (const k of ['gate_c_done', 'gate_d_done', 'gate_d_hardened', 'merged', 'worktree_cleaned']) {
    assert.ok(kinds.includes(k), `the ${k} event is missing`);
  }
});

test('a downstream red line -- the permission gate: someone not in merge_ack_allowed cannot confirm the merge, and merged is refused from any state but AWAITING_HUMAN_MERGE', async () => {
  const id = 'dpf2';
  await mkDone(id);
  // Not yet ready to merge -> merged is refused.
  assert.equal((await actions.ackMerged(id, 'M')).ok, false);
  // Drive it to AWAITING_HUMAN_MERGE.
  await actions.requestGateC(id, 'M');
  await worker.step((await sessions.get(id))!);
  await actions.requestReviewPr(id, 'M');
  await worker.step((await sessions.get(id))!);
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_HUMAN_MERGE');
  // Someone without the permission confirms -> refused, and the state does not move.
  assert.equal((await actions.ackMerged(id, 'ZZ')).ok, false);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_HUMAN_MERGE');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'permission_denied'));
});

test('ackMerged --force: a human can override even when gh says it is not merged -> SHIPPED, with a forced audit record', async () => {
  const id = 'dpf3';
  await mkDone(id);
  await actions.requestGateC(id, 'M');
  await worker.step((await sessions.get(id))!);
  await actions.requestReviewPr(id, 'M');
  await worker.step((await sessions.get(id))!);
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_HUMAN_MERGE');
  prMerged = false; // gh says it is not merged
  assert.equal((await actions.ackMerged(id, 'M')).ok, false, 'without force -> refused');
  const r = await actions.ackMerged(id, 'M', { force: true });
  assert.ok(r.ok, '--force overrides the verification');
  assert.equal((await sessions.get(id))!.state, 'SHIPPED');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'merge_ack_forced'));
  prMerged = true; // restore the shared state
});

test('mergeAckDecision: verified as merged -> proceed; not merged or unreadable -> refuse; --force always overrides and is marked forced', () => {
  assert.equal(actions.mergeAckDecision({ ok: true, merged: true, state: 'MERGED' }, false).proceed, true);
  assert.equal(actions.mergeAckDecision({ ok: true, merged: false, state: 'OPEN' }, false).proceed, false);
  assert.equal(actions.mergeAckDecision({ ok: false, merged: false, state: 'UNKNOWN', error: 'gh failed' }, false).proceed, false);
  const forced = actions.mergeAckDecision({ ok: true, merged: false, state: 'OPEN' }, true);
  assert.equal(forced.proceed, true);
  assert.equal(forced.forced, true);
});
