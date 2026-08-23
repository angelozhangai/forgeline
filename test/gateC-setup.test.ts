// Integration: the key invariants of runGateCSetup delegating worktree creation --
//  - the creation anchor is the **pinned base_sha**, never the moving ref origin/<branch>, so a concurrent or
//    external fetch advancing origin cannot drift the baseline (Codex B1).
//  - the worktree path and branch derive from implIdentity (a hash of the whole id), so two sessions sharing a
//    slug - including a long slug that hits the truncation limit - never delete each other's trees (Codex B,
//    over several review rounds).
//  - the idempotent pre-clean: if the deterministic path already exists (an orphan), delegate to removeWorktree
//    and delete the leftover branch; otherwise touch nothing (Codex SF2).
//  - the repo sha is read precisely: a named repo with no key (even when '.' is present) refuses to build,
//    rather than silently taking another repo's sha (Codex SF).
// The worktree delegation / repoFreshness / projects are mocked; sessions is real (:memory:). No real git runs.
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

interface CreateCall { repoDir: string; path: string; branch: string; baseCommitish: string }
let createCalls: CreateCall[] = [];
let removeCalls: { path: string }[] = [];
let deleteBranchCalls: { branch: string }[] = [];
let listResult: string[] = [];
let freshShas: Record<string, string> = { '.': 'PINSHA_AT_REFRESH' };
let projRepos: string[] = ['.'];

mock.module('../src/util/worktree.ts', {
  namedExports: {
    ensureWorktreeExcluded: () => {},
    defaultWorktreePath: (repoDir: string, key: string) => `${repoDir}-forge-${key}`,
    createWorktree: async (o: CreateCall) => {
      createCalls.push(o);
      return { ok: true, path: o.path, branch: o.branch, output: '' };
    },
    removeWorktree: async (o: { path: string }) => {
      removeCalls.push(o);
      return { ok: true, output: '' };
    },
    listWorktrees: (_repoDir: string) => listResult,
    deleteBranch: (_repoDir: string, branch: string) => {
      deleteBranchCalls.push({ branch });
    },
    worktreeHeadSha: () => null,
  },
});
mock.module('../src/gates/repoFreshness.ts', {
  namedExports: {
    refresh: async () => ({ branch: 'main', refsText: '', shas: freshShas }),
    assertFresh: () => {},
  },
});
mock.module('../src/projects.ts', {
  namedExports: {
    projectForSession: () => ({
      id: 'p',
      root: '/proj',
      repos: projRepos,
      repoPath: (r: string) => (r === '.' ? '/proj/repo' : `/proj/${r}`), // a single repo ('.') keeps /proj/repo; with several repos each gets its own path (so leg paths differ)
      scripts: { ci: './tools/scripts/forge-ci.sh', worktree_add: './tools/scripts/wt.sh' },
    }),
  },
});

const sessions = await import('../src/store/sessions.ts');
const gateC = await import('../src/gates/gateC.ts');
const { mkLeg } = await import('../src/gates/legs.ts');

let n = 0;
async function mkSession(slug: string): Promise<string> {
  const id = `${slug}-id${++n}`; // mimics intake's id = <slug>-<shortId> (unique)
  await sessions.create({ id, slug, title: 'T', branch: 'main' });
  return id;
}

beforeEach(() => {
  createCalls = [];
  removeCalls = [];
  deleteBranchCalls = [];
  listResult = [];
  freshShas = { '.': 'PINSHA_AT_REFRESH' };
  projRepos = ['.'];
});

test('runGateCSetup: the creation anchor is the pinned base_sha (never the moving ref origin/main) and base_shas is persisted', async () => {
  const id = await mkSession('fix-login');
  await gateC.runGateCSetup((await sessions.get(id))!);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].baseCommitish, 'PINSHA_AT_REFRESH'); // B1: the pinned sha
  assert.notEqual(createCalls[0].baseCommitish, 'origin/main'); // never a moving ref
  assert.equal(JSON.parse((await sessions.get(id))!.base_shas!)['.'], 'PINSHA_AT_REFRESH'); // CI and parseFixResult work from the same baseline
});

test('runGateCSetup: the path and branch derive from implIdentity and are persisted consistently (Gate D opens the PR from the same impl_branch)', async () => {
  const id = await mkSession('fix-login');
  const expect = gateC.implIdentity('/proj/repo', id);
  await gateC.runGateCSetup((await sessions.get(id))!);
  assert.equal(createCalls[0].path, expect.worktreePath);
  assert.equal(createCalls[0].branch, expect.implBranch);
  assert.equal((await sessions.get(id))!.worktree_path, expect.worktreePath); // what is persisted is the normalised value
  assert.equal((await sessions.get(id))!.impl_branch, expect.implBranch);
});

test('runGateCSetup: two setups sharing a slug -> different paths and branches, and the second does not delete the first (Codex B1)', async () => {
  const a = await mkSession('dup-title');
  const b = await mkSession('dup-title'); // same slug, different id
  await gateC.runGateCSetup((await sessions.get(a))!);
  await gateC.runGateCSetup((await sessions.get(b))!);
  assert.notEqual(createCalls[0].path, createCalls[1].path);
  assert.notEqual(createCalls[0].branch, createCalls[1].branch);
  assert.equal(removeCalls.length, 0); // neither touched the other's worktree
  assert.equal(deleteBranchCalls.length, 0);
});

test('runGateCSetup: two setups sharing a long slug (one that hits slugify truncation) still do not collide or delete each other (the hash carries the uniqueness - Codex, fourth review, finding B)', async () => {
  const slug = 'z'.repeat(45); // longer than slugify's .slice(40), which the old implementation truncated into a single shared key
  const a = await mkSession(slug);
  const b = await mkSession(slug);
  await gateC.runGateCSetup((await sessions.get(a))!);
  await gateC.runGateCSetup((await sessions.get(b))!);
  assert.notEqual(createCalls[0].path, createCalls[1].path); // the hash keeps them apart; the old implementation made these equal
  assert.notEqual(createCalls[0].branch, createCalls[1].branch);
  assert.equal(removeCalls.length, 0); // the second setup did not delete the first one's live worktree
});

test('runGateCSetup: an orphan already at the deterministic path -> delegate to removeWorktree, delete the leftover branch, then rebuild (SF2)', async () => {
  const id = await mkSession('orphaned');
  const { worktreePath, implBranch } = gateC.implIdentity('/proj/repo', id);
  listResult = [worktreePath]; // simulates a physical orphan from a previous run that crashed between create and persisting worktree_path
  await gateC.runGateCSetup((await sessions.get(id))!);
  assert.equal(removeCalls.length, 1);
  assert.equal(removeCalls[0].path, worktreePath);
  assert.deepEqual(deleteBranchCalls, [{ branch: implBranch }]);
  assert.equal(createCalls.length, 1); // it rebuilds as normal once the orphan is cleaned
});

// -- Persisting the legs (one per repo). A single repo yields exactly one leg. --
test('runGateCSetup: persists the legs - a single repo gives exactly one leg (the primary), mirroring the session worktree and base_sha', async () => {
  const id = await mkSession('one-repo');
  await gateC.runGateCSetup((await sessions.get(id))!);
  const legs = JSON.parse((await sessions.get(id))!.legs!);
  assert.equal(legs.length, 1);
  assert.equal(legs[0].repo, '.');
  assert.equal(legs[0].worktree_path, (await sessions.get(id))!.worktree_path);
  assert.equal(legs[0].base_sha, 'PINSHA_AT_REFRESH');
});

test('runGateCSetup (multi-repo): one tree and one leg per target repo (each base_sha pinned per repo, worktree paths distinct, and the session pointing at the primary)', async () => {
  projRepos = ['demo', 'example-web'];
  freshShas = { demo: 'SHA_C', 'example-web': 'SHA_U' };
  const id = await mkSession('multi-repo');
  await sessions.patch(id, { target_repos: JSON.stringify(['demo', 'example-web']) });
  await gateC.runGateCSetup((await sessions.get(id))!);
  const legs = JSON.parse((await sessions.get(id))!.legs!);
  assert.deepEqual(
    legs.map((l: { repo: string }) => l.repo),
    ['demo', 'example-web'],
  );
  assert.equal(legs[0].base_sha, 'SHA_C'); // each repo pins its own sha (never another repo's baseline)
  assert.equal(legs[1].base_sha, 'SHA_U');
  assert.ok(legs[0].worktree_path && legs[1].worktree_path);
  assert.notEqual(legs[0].worktree_path, legs[1].worktree_path); // each repo has its own hidden .forge/worktrees/ directory
  assert.equal(createCalls.length, 2); // one creation per repo
  assert.equal((await sessions.get(id))!.worktree_path, legs[0].worktree_path); // the session points at the primary (where sequential driving starts)
});

test('runGateCSetup (multi-repo): refresh returns no base sha for one repo -> throw (never build on the wrong repo or a moving ref) rather than silently creating half the set', async () => {
  projRepos = ['demo', 'example-web'];
  freshShas = { demo: 'SHA_C' }; // example-web is missing
  const id = await mkSession('multi-missing-sha');
  await sessions.patch(id, { target_repos: JSON.stringify(['demo', 'example-web']) });
  const s = (await sessions.get(id))!;
  await assert.rejects(() => gateC.runGateCSetup(s), /no base sha for example-web/);
});

// -- activeLeg / activateLeg: the two primitives of sequential driving (go green on one, switch to the next) --
test('activeLeg: matches the active leg by worktree_path; otherwise takes the first leg that is not green', () => {
  const legs = [mkLeg('demo', { worktree_path: '/wt/c', ci_ok: true }), mkLeg('example-web', { worktree_path: '/wt/u' })];
  const s = { worktree_path: '/wt/u', legs: JSON.stringify(legs) };
  assert.equal(gateC.activeLeg(s)!.repo, 'example-web'); // matched on worktree_path
  assert.equal(gateC.activeLeg({ worktree_path: null, legs: JSON.stringify(legs) })!.repo, 'example-web'); // falls back to the first leg that is not green
  assert.equal(gateC.activeLeg({ worktree_path: null, legs: null }), null);
});

test('activateLeg: points the session at that leg (worktree, branch, base_shas) and resets the Gate C loop state', async () => {
  const id = await mkSession('activate');
  await sessions.patch(id, { gate_c_round: 3, gate_c_fixer_session: 'old', worktree_path: '/old' });
  await gateC.activateLeg((await sessions.get(id))!, mkLeg('example-web', { worktree_path: '/wt/u', impl_branch: 'forge/k', base_sha: 'SHA_U' }));
  const s = (await sessions.get(id))!;
  assert.equal(s.worktree_path, '/wt/u');
  assert.equal(s.impl_branch, 'forge/k');
  assert.equal(JSON.parse(s.base_shas!)['example-web'], 'SHA_U');
  assert.equal(s.gate_c_round, null); // switching legs resets the loop state
  assert.equal(s.gate_c_fixer_session, null);
});

test('activateLeg: Gate D re-pointing at a leg carries that leg\'s pr_url/pr_number and resets the whole Gate D loop state (the previous leg\'s review and hardening must never skew the next one)', async () => {
  const id = await mkSession('activate-d');
  // simulates the session-level Gate D state left behind after a previous leg finished Gate D
  await sessions.patch(id, {
    gate_d_round: 2, gate_d_reviewer_session: 'codex-old', gate_d_fixer_session: 'cl-old',
    gate_d_green_sha: 'OLDGREEN', gate_d_harden_round: 1, gate_d_harden_verified_sha: 'OLDV',
    merge_readiness_path: '/old/mr.md', pr_url: 'OLD_PR', pr_number: 1,
  });
  await gateC.activateLeg((await sessions.get(id))!, mkLeg('example-web', { worktree_path: '/wt/u', impl_branch: 'forge/k', base_sha: 'SHA_U', pr_url: 'NEW_PR', pr_number: 22 }));
  const s = (await sessions.get(id))!;
  assert.equal(s.pr_url, 'NEW_PR'); // points at this leg's PR (review, merge and notifications all align with it)
  assert.equal(s.pr_number, 22);
  assert.equal(s.gate_d_round, null); // the whole Gate D loop state is zeroed
  assert.equal(s.gate_d_reviewer_session, null);
  assert.equal(s.gate_d_fixer_session, null);
  assert.equal(s.gate_d_green_sha, null);
  assert.equal(s.gate_d_harden_round, null);
  assert.equal(s.gate_d_harden_verified_sha, null);
  assert.equal(s.merge_readiness_path, null);
});

test('runGateCSetup: no orphan -> nothing is deleted (the pre-clean only fires when the path already exists)', async () => {
  const id = await mkSession('clean');
  await gateC.runGateCSetup((await sessions.get(id))!);
  assert.equal(removeCalls.length, 0);
  assert.equal(deleteBranchCalls.length, 0);
});

test('runGateCSetup: refresh returns no base sha -> throw (refusing to pin to a moving ref) and create nothing', async () => {
  freshShas = {}; // refresh returned no sha at all
  const id = await mkSession('no-sha');
  const s = (await sessions.get(id))!;
  await assert.rejects(() => gateC.runGateCSetup(s), /the worktree baseline cannot be pinned/);
  assert.equal(createCalls.length, 0);
});

test('runGateCSetup: a named repo has no key but "." does -> throw (read this repo\'s sha precisely, never silently take "." - Codex SF)', async () => {
  projRepos = ['libs']; // repo !== '.'
  freshShas = { '.': 'sha-for-dot' }; // only '.' is present; 'libs' is missing
  const id = await mkSession('named-repo');
  const s = (await sessions.get(id))!;
  await assert.rejects(() => gateC.runGateCSetup(s), /the worktree baseline cannot be pinned/);
  assert.equal(createCalls.length, 0);
});
