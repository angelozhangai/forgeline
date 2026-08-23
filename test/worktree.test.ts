// Unit: the delegated worktree lifecycle in worktree.ts. It mocks proc's run/runSync and asserts that the
// delegated bin and args are right, that a failure returns ok:false rather than throwing, and that listing
// orphans or querying HEAD degrades rather than guessing when git errors. No real git process is started.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface RunCall {
  bin: string;
  args: string[];
  cwd?: string;
}
let runCalls: RunCall[] = [];
let runResult = { code: 0, stdout: '', stderr: '', timedOut: false };
let syncOut = '';
let syncThrow = false;
let syncCalls: string[][] = [];

mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (bin: string, args: string[], opts: { cwd?: string } = {}) => {
      runCalls.push({ bin, args, cwd: opts.cwd });
      return runResult;
    },
    runSync: (_bin: string, args: string[]) => {
      syncCalls.push(args);
      if (syncThrow) throw new Error('git boom');
      return syncOut;
    },
  },
});

const { defaultWorktreePath, worktreeRoot, ensureWorktreeExcluded, createWorktree, removeWorktree, listWorktrees, worktreeHeadSha, deleteBranch, planWorktreeSweep } =
  await import('../src/util/worktree.ts');

beforeEach(() => {
  runCalls = [];
  runResult = { code: 0, stdout: 'ok', stderr: '', timedOut: false };
  syncOut = '';
  syncThrow = false;
  syncCalls = [];
});

test("defaultWorktreePath: lands in that repo's hidden .forge/worktrees/<key> (the top rule: a worktree belongs to its own repo and is never piled into the umbrella)", () => {
  assert.equal(worktreeRoot('/ws/your-monorepo'), '/ws/your-monorepo/.forge/worktrees');
  const p = defaultWorktreePath('/ws/your-monorepo', 'fix-login');
  assert.equal(p, '/ws/your-monorepo/.forge/worktrees/fix-login');
});

test('createWorktree (delegating to wt.sh): bash <script> <path> -b <branch> <baseCommitish=the pinned sha>, cwd=the main repo', async () => {
  const r = await createWorktree({
    repoDir: '/ws/your-monorepo',
    path: '/ws/your-monorepo-forge-x',
    branch: 'forge/x',
    baseCommitish: 'deadbeefpinsha', // the tree is anchored to an immutable sha, not a moving ref (Codex B1)
    addScript: '/ws/your-monorepo/tools/scripts/wt.sh',
  });
  assert.equal(r.ok, true);
  assert.equal(runCalls.length, 1);
  assert.deepEqual(runCalls[0], {
    bin: 'bash',
    args: ['/ws/your-monorepo/tools/scripts/wt.sh', '/ws/your-monorepo-forge-x', '-b', 'forge/x', 'deadbeefpinsha'],
    cwd: '/ws/your-monorepo',
  });
});

test('createWorktree (no script -> bare git fallback): git -C <repo> worktree add ...', async () => {
  await createWorktree({ repoDir: '/r', path: '/r-forge-x', branch: 'forge/x', baseCommitish: 'deadbeefpinsha' });
  assert.deepEqual(runCalls[0].args, ['-C', '/r', 'worktree', 'add', '/r-forge-x', '-b', 'forge/x', 'deadbeefpinsha']);
  assert.equal(runCalls[0].bin, 'git');
});

test('createWorktree: the script exits non-zero -> ok:false (it does not throw; the caller parks)', async () => {
  runResult = { code: 1, stdout: '', stderr: 'wt failed', timedOut: false };
  const r = await createWorktree({ repoDir: '/r', path: '/r-x', branch: 'b', baseCommitish: 'sha' });
  assert.equal(r.ok, false);
  assert.match(r.output, /wt failed/);
});

test('createWorktree: a timeout -> ok:false', async () => {
  runResult = { code: 0, stdout: '', stderr: '', timedOut: true };
  const r = await createWorktree({ repoDir: '/r', path: '/r-x', branch: 'b', baseCommitish: 'sha' });
  assert.equal(r.ok, false);
});

test('removeWorktree (no script -> fallback): git worktree remove --force + prune', async () => {
  const r = await removeWorktree({ repoDir: '/r', path: '/r-x' });
  assert.equal(r.ok, true);
  assert.equal(runCalls.length, 2);
  assert.deepEqual(runCalls[0].args, ['-C', '/r', 'worktree', 'remove', '--force', '/r-x']);
  assert.deepEqual(runCalls[1].args, ['-C', '/r', 'worktree', 'prune']);
});

test('removeWorktree (delegating to a script): bash <removeScript> <path>', async () => {
  await removeWorktree({ repoDir: '/r', path: '/r-x', removeScript: '/r/scripts/wt-rm.sh' });
  assert.equal(runCalls.length, 1);
  assert.deepEqual(runCalls[0], { bin: 'bash', args: ['/r/scripts/wt-rm.sh', '/r-x'], cwd: '/r' });
});

test('listWorktrees: parses the worktree lines of the porcelain output; degrades to [] on error', () => {
  syncOut = 'worktree /ws/your-monorepo\nHEAD abc\nbranch refs/heads/main\n\nworktree /ws/your-monorepo-forge-x\nHEAD def\n';
  assert.deepEqual(listWorktrees('/ws/your-monorepo'), ['/ws/your-monorepo', '/ws/your-monorepo-forge-x']);
  syncThrow = true;
  assert.deepEqual(listWorktrees('/ws/your-monorepo'), []);
});

test('worktreeHeadSha: returns the trimmed sha; returns null on error', () => {
  syncOut = 'deadbeef1234\n';
  assert.equal(worktreeHeadSha('/r-x'), 'deadbeef1234');
  syncThrow = true;
  assert.equal(worktreeHeadSha('/r-x'), null);
});

test('deleteBranch: git -C <repo> branch -D <branch>; a failed deletion is swallowed rather than thrown (a missing branch is the normal case)', () => {
  deleteBranch('/r', 'forge/x');
  assert.deepEqual(syncCalls.at(-1), ['-C', '/r', 'branch', '-D', 'forge/x']);
  // The pre-orphan-cleanup case: the branch may not exist, or deletion may fail -> it must never throw (or a
  // re-setup would crash outright).
  syncThrow = true;
  assert.doesNotThrow(() => deleteBranch('/r', 'forge/x'));
});

// ── The orphan-worktree sweep decision (planWorktreeSweep, a pure function) ──
test('planWorktreeSweep: clears SHIPPED leftovers and ownerless forge orphans; never touches one in use, too new, or non-forge with no owner', () => {
  const H = 3600_000;
  const onDisk = [
    { path: '/p/repo-forge-live', ageMs: 5 * H }, // in use (a non-terminal session) -> kept
    { path: '/p/repo-forge-shipped', ageMs: 5 * H }, // a SHIPPED leftover -> cleared
    { path: '/p/repo-forge-orphan', ageMs: 5 * H }, // an ownerless forge orphan -> cleared
    { path: '/p/repo-forge-fresh', ageMs: 0.1 * H }, // forge, but too new (it may be under construction) -> kept
    { path: '/p/user-scratch', ageMs: 9 * H }, // not forge and ownerless -> kept (never delete a user's worktree)
  ];
  const sweep = planWorktreeSweep({
    onDisk,
    shippedPaths: new Set(['/p/repo-forge-shipped']),
    livePaths: new Set(['/p/repo-forge-live']),
    minAgeMs: 1 * H,
  });
  assert.deepEqual(sweep.sort(), ['/p/repo-forge-orphan', '/p/repo-forge-shipped']);
});

test('planWorktreeSweep: in use beats everything — even if it also happens to be in shippedPaths and is ancient, it is not cleared (a worktree in use is never destroyed)', () => {
  const sweep = planWorktreeSweep({
    onDisk: [{ path: '/p/repo-forge-x', ageMs: 99 * 3600_000 }],
    shippedPaths: new Set(['/p/repo-forge-x']),
    livePaths: new Set(['/p/repo-forge-x']),
    minAgeMs: 3600_000,
  });
  assert.deepEqual(sweep, []);
});

test('planWorktreeSweep: a SHIPPED leftover that is too new -> still kept (the age-protection window wins, so a tree under construction is never hit)', () => {
  const sweep = planWorktreeSweep({
    onDisk: [{ path: '/p/repo-forge-x', ageMs: 10_000 }],
    shippedPaths: new Set(['/p/repo-forge-x']),
    livePaths: new Set(),
    minAgeMs: 3600_000,
  });
  assert.deepEqual(sweep, []);
});

test('planWorktreeSweep: the current .forge/worktrees/ path segment is recognised as a forge orphan too (ownerless -> cleared)', () => {
  const sweep = planWorktreeSweep({
    onDisk: [
      { path: '/p/demo/.forge/worktrees/req-abc', ageMs: 5 * 3600_000 }, // an ownerless orphan under the current convention -> cleared
      { path: '/p/example-web/.forge/worktrees/req-live', ageMs: 5 * 3600_000 }, // in use -> kept
    ],
    shippedPaths: new Set(),
    livePaths: new Set(['/p/example-web/.forge/worktrees/req-live']),
    minAgeMs: 3600_000,
  });
  assert.deepEqual(sweep, ['/p/demo/.forge/worktrees/req-abc']);
});

// ── ensureWorktreeExcluded: writes .forge/ into that repo's local .git/info/exclude (never committed, and
// the product repo's .gitignore is left alone) ──
test("ensureWorktreeExcluded: writes /.forge/ into the main checkout's .git/info/exclude, idempotently", () => {
  const repo = mkdtempSync(join(tmpdir(), 'forge-wt-'));
  mkdirSync(join(repo, '.git'));
  ensureWorktreeExcluded(repo);
  const ex = join(repo, '.git', 'info', 'exclude');
  assert.ok(existsSync(ex));
  const first = readFileSync(ex, 'utf8');
  assert.match(first, /^\/\.forge\/$/m); // one line is exactly /.forge/
  ensureWorktreeExcluded(repo); // call it again
  assert.equal(readFileSync(ex, 'utf8'), first); // idempotent: the content is unchanged, never appended twice
});

test('ensureWorktreeExcluded: .git is a file (a worktree/gitfile) or missing -> skipped, no throw', () => {
  const f = mkdtempSync(join(tmpdir(), 'forge-wt-'));
  writeFileSync(join(f, '.git'), 'gitdir: /elsewhere\n'); // .git as a file
  ensureWorktreeExcluded(f); // does not throw
  assert.ok(!existsSync(join(f, '.git', 'info', 'exclude')));
  const none = mkdtempSync(join(tmpdir(), 'forge-wt-')); // no .git at all
  ensureWorktreeExcluded(none); // does not throw
});
