// Integration (costs nothing): the **sequential-driving wiring** of Gate D's multi-repo "one repo, one tree,
// one PR" model - using the **real** gateC (activateLeg / activeLeg), the real legs helpers, the real
// worker.step and the real state machine, with only the drivers mocked (opening the PR, reviewing the diff,
// hardening). What it verifies is how the worker chains Gate D across the legs:
//  - after GATE_D_REQUESTED has opened N PRs, it **re-points at the primary leg** (the fix for Codex's blocker:
//    otherwise it reviews the last gate-C leg while carrying the primary's PR).
//  - once a leg finishes hardening -> persist its Gate D terminal state back onto the leg -> switch to the next
//    and return to GATE_D_LOOP; **only once every leg has hardened** does it reach AWAITING_HUMAN_MERGE.
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
const { loadConfig } = await import('../src/config.ts'); // a dynamic import (never a static one! a static import hoists above FORGE_DB=':memory:', so root.ts would resolve the real database and concurrent tests would share it). The stub falls back to the real config.

const notifyCalls: string[] = [];
const sessionsRef: { mod?: typeof import('../src/store/sessions.ts') } = {};
mock.module('../src/notify.ts', { namedExports: { notify: async (k: string) => { notifyCalls.push(k); }, syncGroupCard: async () => {} } });

// The upstream gates are not exercised by this flow, but the worker imports them at module level -> no-ops.
mock.module('../src/gates/gateA.ts', { namedExports: { runGateA: async () => ({ round: 1, openQuestions: 0, resolved: true, stalled: false }), runGateARevision: async () => ({ round: 1, openQuestions: 0, resolved: true, stalled: false }) } });
mock.module('../src/gates/gateB.ts', { namedExports: { runGateB: async () => ({}), finalizeGateBDoc: () => {} } });
mock.module('../src/gates/gateBLoop.ts', { namedExports: { runGateBLoop: async () => ({ round: 1, verdict: 'clean', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] }) } });
mock.module('../src/gates/gateALoop.ts', { namedExports: { runGateALoop: async () => ({ round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] }), readGateAEnvelope: () => ({ summary: 's', open_questions: [], risks: [] }) } });
mock.module('../src/util/load.ts', { namedExports: { probeLoad: async () => [] } });
mock.module('../src/gates/gateCLoop.ts', { namedExports: { runGateCLoop: async () => ({ round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] }) } });

const RESOLVED = { round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
mock.module('../src/gates/gateDLoop.ts', { namedExports: { runGateDLoop: async () => RESOLVED, MAX_CI_FIX_ATTEMPTS: 2 } });
// Opening the PRs (mocking the real side effects): it writes a pr_url onto each leg and sets
// session.pr_url to the primary's, but deliberately **leaves worktree_path alone** (so the session still points
// at the last gate-C leg). That reproduces the blocker's precondition and checks whether the worker re-points
// at the primary.
mock.module('../src/gates/gateD.ts', {
  namedExports: {
    openReviewPr: async (s: { id: string }) => {
      const cur = (await sessionsRef.mod!.get(s.id))!;
      const legs = (JSON.parse(cur.legs!) as { repo: string }[]).map((l, i) => ({ ...l, pr_url: `https://x/pull/${i === 0 ? 11 : 22}`, pr_number: i === 0 ? 11 : 22 }));
      await sessionsRef.mod!.patch(s.id, { legs: JSON.stringify(legs), pr_url: legs[0].pr_url, pr_number: legs[0].pr_number });
    },
  },
});
// Hardening (mocked): it sets harden_round, the verified sha and the report path (the real hardening pins the
// verified sha, and the worker uses that to mark the leg as through Gate D).
mock.module('../src/gates/gateDHarden.ts', {
  namedExports: {
    runGateDHarden: async (s: { id: string }) => {
      const cur = (await sessionsRef.mod!.get(s.id))!;
      const repo = cur.worktree_path === UWT ? 'example-web' : 'demo';
      await sessionsRef.mod!.patch(s.id, { gate_d_harden_round: 1, gate_d_harden_verified_sha: `VERIFIED-${repo}`, merge_readiness_path: `/tmp/mr.${repo}.md` });
    },
  },
});
// worktree: since the real gateC is used (activateLeg / activeLeg), this mock must export everything gateC
// needs (createWorktree / defaultWorktreePath / ensureWorktreeExcluded) as well as what the worker uses.
mock.module('../src/util/worktree.ts', {
  namedExports: {
    worktreeHeadSha: () => 'GREENSHA',
    createWorktree: async () => ({ ok: true, output: '' }),
    removeWorktree: async () => ({ ok: true, output: '' }),
    deleteBranch: () => {},
    listWorktrees: () => [],
    planWorktreeSweep: () => [],
    defaultWorktreePath: (repoDir: string, key: string) => `${repoDir}/.forge/worktrees/${key}`,
    ensureWorktreeExcluded: () => {},
  },
});
const projStub = { id: 'p', root: '/proj', repos: ['demo', 'example-web'], repoPath: (r: string) => `/proj/${r}`, deliveryDir: '/tmp', scripts: {} };
mock.module('../src/projects.ts', { namedExports: { projectForSession: () => projStub, project: () => projStub, defaultProjectId: () => 'p', configForProject: () => loadConfig(), configForSession: () => loadConfig() } });
mock.module('../src/util/proc.ts', { namedExports: { run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }), runSync: () => '', commandExists: () => true } });
// The downstream delivery-doc commit (the worker calls it when every leg has hardened and it moves to
// merge-ready): the call is captured and reported as committed. The doWrites stub exists because actions
// imports it; this flow never calls it.
const deliveryDocCalls: string[] = [];
mock.module('../src/writes.ts', {
  namedExports: {
    maybeCommitDeliveryDocs: async (s: { id: string }) => { deliveryDocCalls.push(s.id); return { ok: true, committed: true }; },
    doWrites: async () => ({ ok: true, stdout: '', issues: [] }),
  },
});

const sessions = await import('../src/store/sessions.ts');
sessionsRef.mod = sessions;
const worker = await import('../src/orchestrator/worker.ts');
const { mkLeg, getLegs } = await import('../src/gates/legs.ts');

const CWT = '/proj/demo/.forge/worktrees/k';
const UWT = '/proj/example-web/.forge/worktrees/k';

// Build a session parked at GATE_D_REQUESTED with two legs already created, where the session still points at
// **the last gate-C leg (example-web)** - reproducing the blocker's precondition.
async function mkTwoLegAtGateDRequested(id: string): Promise<void> {
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  for (const st of ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE', 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'AWAITING_GATE_D', 'GATE_D_REQUESTED']) {
    await sessions.transition(id, st as never);
  }
  await sessions.patch(id, {
    legs: JSON.stringify([
      mkLeg('demo', { worktree_path: CWT, impl_branch: 'forge/k', base_sha: 'C', ci_ok: true }),
      mkLeg('example-web', { worktree_path: UWT, impl_branch: 'forge/k', base_sha: 'U', ci_ok: true }),
    ]),
    worktree_path: UWT, // Gate C handled example-web last, so the session points at it rather than the primary
    base_shas: JSON.stringify({ 'example-web': 'U' }),
  });
}

test('multi-repo Gate D: GATE_D_REQUESTED opens both PRs -> **re-point at the primary (demo)** and go GATE_D_LOOP -> LGTM -> HARDENING (it no longer reviews the last leg)', async () => {
  notifyCalls.length = 0;
  const id = 'gdl1';
  await mkTwoLegAtGateDRequested(id);
  await worker.step((await sessions.get(id))!); // openPR -> re-point at the primary -> LOOP -> LGTM -> HARDENING (straight through to the next resting point)
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_D_HARDENING');
  assert.equal(s.worktree_path, CWT, 'it re-points at the primary (demo) and never stays on the last gate-C leg (example-web)'); // the crux of the blocker fix
  assert.equal(s.pr_url, 'https://x/pull/11', 'session.pr_url is the primary (demo) PR');
  assert.equal(s.gate_d_green_sha, 'GREENSHA'); // afterGateD pins the green sha on the primary worktree
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_d_leg_active'));
});

test('multi-repo Gate D: the primary finishes hardening -> switch to example-web and return to GATE_D_LOOP, with the demo leg carrying its "through Gate D" terminal state', async () => {
  const id = 'gdl2';
  await mkTwoLegAtGateDRequested(id);
  await worker.step((await sessions.get(id))!); // -> GATE_D_HARDENING (demo)
  await worker.step((await sessions.get(id))!); // harden demo -> switch to example-web -> GATE_D_LOOP
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_D_LOOP');
  assert.equal(s.worktree_path, UWT, 'it switched to the second leg (example-web)');
  assert.equal(s.pr_url, 'https://x/pull/22', 'pr_url now aligns with example-web');
  const legs = getLegs(s);
  assert.equal(legs.find((l) => l.repo === 'demo')!.gate_d_harden_verified_sha, 'VERIFIED-demo', 'the demo leg carries its through-Gate-D terminal state');
  assert.equal(legs.find((l) => l.repo === 'demo')!.merge_readiness_path, '/tmp/mr.demo.md', 'the demo leg keeps its own merge-readiness report');
  assert.equal(legs.find((l) => l.repo === 'example-web')!.gate_d_harden_verified_sha, null, 'example-web has not been through yet');
  assert.equal(s.gate_d_harden_round, null, 'switching legs reset the Gate D loop state');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_d_leg_done'));
  assert.ok(!(await sessions.events(id)).some((e) => e.kind === 'delivery_docs_committed'), 'advancing mid-way through the legs must never commit the delivery docs (that only happens once every leg has hardened)');
});

test('multi-repo Gate D: only once both legs have hardened does it reach AWAITING_HUMAN_MERGE + needs_merge (the red line: nothing is ever merged automatically)', async () => {
  notifyCalls.length = 0;
  const id = 'gdl3';
  await mkTwoLegAtGateDRequested(id);
  await worker.step((await sessions.get(id))!); // demo: openPR -> re-point -> LGTM -> HARDENING
  await worker.step((await sessions.get(id))!); // harden demo -> switch to example-web -> GATE_D_LOOP
  assert.equal((await sessions.get(id))!.state, 'GATE_D_LOOP'); // still in Gate D (it must not reach merge-ready while only demo is green)
  await worker.step((await sessions.get(id))!); // example-web: LGTM -> HARDENING
  assert.equal((await sessions.get(id))!.state, 'GATE_D_HARDENING');
  await worker.step((await sessions.get(id))!); // harden example-web -> every leg is through Gate D -> AWAITING_HUMAN_MERGE
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_HUMAN_MERGE');
  assert.ok(notifyCalls.includes('needs_merge'));
  const legs = getLegs(s);
  assert.deepEqual(legs.map((l) => [l.repo, l.gate_d_harden_verified_sha, l.merge_readiness_path]), [
    ['demo', 'VERIFIED-demo', '/tmp/mr.demo.md'],
    ['example-web', 'VERIFIED-example-web', '/tmp/mr.example-web.md'],
  ], 'both legs are through Gate D, and each keeps its own merge-readiness report');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_d_hardened'));
  // The downstream delivery docs (including each repo's merge-readiness report) are archived together at this
  // point (gated by config, and never pushed).
  assert.ok(deliveryDocCalls.includes(id), 'reaching merge-ready triggers the delivery-doc commit exactly once');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'delivery_docs_committed'), 'a successful commit records a delivery_docs_committed event');
});
