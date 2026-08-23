// Unit tests for ci.ts's deterministic CI gate and the worktree git helpers. proc is mocked to assert the
// ran/ok semantics of CI, that a missing script parks, that nothing is committed when nothing changed, and
// that the degraded paths do not throw. No real CI or git process is started.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let runResult = { code: 0, stdout: '', stderr: '', timedOut: false };
let runCalls: { bin: string; args: string[]; cwd?: string }[] = [];
let syncBy: (args: string[]) => string = () => '';

mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (bin: string, args: string[], opts: { cwd?: string } = {}) => {
      runCalls.push({ bin, args, cwd: opts.cwd });
      return runResult;
    },
    runSync: (_bin: string, args: string[]) => syncBy(args),
  },
});

const { runCi, hasCommitsSince, diffStatSince, changedFilesSince, commitWorktree, worktreeClean, resetWorktree } = await import('../src/gates/ci.ts');

beforeEach(() => {
  runResult = { code: 0, stdout: 'all green', stderr: '', timedOut: false };
  runCalls = [];
  syncBy = () => '';
});

test('runCi: no scripts.ci configured -> ran:false (never a bare nx; park for a human)', async () => {
  const r = await runCi('/wt', undefined);
  assert.equal(r.ran, false);
  assert.equal(r.ok, false);
  assert.match(r.summary, /no scripts\.ci configured/);
  assert.equal(runCalls.length, 0);
});

test('runCi: the script exits 0 -> ok:true ran:true, with cwd=worktree and bash <script> affected --base', async () => {
  const r = await runCi('/wt', '/wt/tools/scripts/forge-ci.sh', { base: 'origin/main' });
  assert.equal(r.ok, true);
  assert.equal(r.ran, true);
  assert.equal(runCalls[0].cwd, '/wt');
  assert.deepEqual(runCalls[0].args, ['/wt/tools/scripts/forge-ci.sh', 'affected', '--base', 'origin/main']);
});

test('runCi: the script exits non-zero (tests failed) -> ran:true ok:false (red, fed to claude for the fix, not parked)', async () => {
  runResult = { code: 1, stdout: 'FAIL libs/x', stderr: '', timedOut: false };
  const r = await runCi('/wt', '/wt/forge-ci.sh');
  assert.equal(r.ran, true);
  assert.equal(r.ok, false);
  assert.match(r.summary, /FAIL libs\/x/);
});

test('runCi: a spawn failure (code=null) or a timeout -> ran:false (an infrastructure error; park)', async () => {
  runResult = { code: null, stdout: '', stderr: 'ENOENT', timedOut: false };
  assert.equal((await runCi('/wt', '/wt/forge-ci.sh')).ran, false);
  runResult = { code: 0, stdout: '', stderr: '', timedOut: true };
  assert.equal((await runCi('/wt', '/wt/forge-ci.sh')).ran, false);
});

test('hasCommitsSince: a non-zero rev-list count -> true; 0 -> false', () => {
  syncBy = () => '2\n';
  assert.equal(hasCommitsSince('/wt', 'base'), true);
  syncBy = () => '0\n';
  assert.equal(hasCommitsSince('/wt', 'base'), false);
});

test('changedFilesSince: parses the name-only lines; degrades to [] on error', () => {
  syncBy = () => 'libs/a.ts\napps/b.ts\n';
  assert.deepEqual(changedFilesSince('/wt', 'base'), ['libs/a.ts', 'apps/b.ts']);
  syncBy = () => { throw new Error('git boom'); };
  assert.deepEqual(changedFilesSince('/wt', 'base'), []);
  assert.equal(diffStatSince('/wt', 'base'), '');
});

test('commitWorktree: with changes -> add -A + commit (forge author + --no-verify) -> ok:true committed:true', () => {
  const seen: string[][] = [];
  syncBy = (args) => {
    seen.push(args);
    if (args.includes('status')) return ' M libs/a.ts\n'; // there are changes
    return 'committed';
  };
  const r = commitWorktree('/wt', 'forge(gate C x): round 1');
  assert.equal(r.ok, true);
  assert.equal(r.committed, true);
  const commitArgs = seen.find((a) => a.includes('commit'))!;
  assert.ok(commitArgs.includes('--no-verify'));
  assert.ok(commitArgs.includes('user.email=forge@local'));
});

test('commitWorktree: nothing changed -> ok:true committed:false (no empty commit, but a success — distinct from a failure)', () => {
  syncBy = (args) => (args.includes('status') ? '' : 'x'); // a clean working tree
  const r = commitWorktree('/wt', 'm');
  assert.equal(r.ok, true);
  assert.equal(r.committed, false);
});

test('commitWorktree: the commit throws -> ok:false (a failed commit is not "nothing changed"; the caller parks on it, and never runs CI or pushes with a dirty tree)', () => {
  syncBy = (args) => {
    if (args.includes('status')) return ' M libs/a.ts\n'; // there are changes
    if (args.includes('commit')) throw new Error('commit boom'); // the commit blew up (add -A already staged the changes)
    return '';
  };
  const r = commitWorktree('/wt', 'm');
  assert.equal(r.ok, false);
  assert.equal(r.committed, false);
});

test('worktreeClean: empty porcelain -> true; non-empty -> false; an error -> false (conservatively dirty, forcing a park)', () => {
  syncBy = () => '';
  assert.equal(worktreeClean('/wt'), true);
  syncBy = () => ' M a.ts\n';
  assert.equal(worktreeClean('/wt'), false);
  syncBy = () => { throw new Error('git boom'); };
  assert.equal(worktreeClean('/wt'), false);
});

test('resetWorktree: reset --hard <sha> + clean -fd + a re-check of porcelain afterwards; all zero and clean -> ok:true', () => {
  const seen: string[][] = [];
  syncBy = (args) => { seen.push(args); return ''; };
  const r = resetWorktree('/wt', 'PREHEAD');
  assert.equal(r.ok, true);
  assert.deepEqual(seen[0], ['-C', '/wt', 'reset', '--hard', 'PREHEAD']);
  assert.deepEqual(seen[1], ['-C', '/wt', 'clean', '-fd']);
  assert.deepEqual(seen[2], ['-C', '/wt', 'status', '--porcelain']); // checked once more after the reset
  syncBy = () => { throw new Error('reset boom'); };
  assert.equal(resetWorktree('/wt', 'PREHEAD').ok, false);
});

test('resetWorktree: reset/clean exit 0 but the status is still not clean afterwards (nested repo / submodule leftovers) -> ok:false (do not pretend the reset worked)', () => {
  syncBy = (args) => (args.includes('status') ? ' M sub/x\n' : ''); // reset/clean exit 0 but the status is still dirty
  const r = resetWorktree('/wt', 'PREHEAD');
  assert.equal(r.ok, false);
  assert.match(r.output, /still not clean/);
});
