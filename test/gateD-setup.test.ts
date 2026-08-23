// Integration: the key invariants of openReviewPr delegating PR creation --
//  - it delegates to proj.scripts.create_pr (cwd = the worktree, --base = session.branch) and never re-creates
//    gh inside forge.
//  - it parses the PR URL and number out of the script's last stdout line and persists them; if the last line
//    is not a URL, or the script fails, it throws (the worker parks at GATE_D_FAILED rather than silently
//    recording nothing).
// proc.run / projects / the gateC envelope are mocked; sessions is real (:memory:). No real gh or git runs.
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

interface RunCall { bin: string; args: string[]; cwd?: string }
type RunRes = { code: number; stdout: string; stderr: string; timedOut: boolean };
let runCalls: RunCall[] = [];
let runResult: RunRes = { code: 0, stdout: '', stderr: '', timedOut: false };
let runQueue: RunRes[] = []; // several PRs: each run shifts the head of the queue (falling back to runResult), so each repo can return its own PR URL

mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (bin: string, args: string[], opts: { cwd?: string } = {}) => {
      runCalls.push({ bin, args, cwd: opts.cwd });
      return runQueue.length ? (runQueue.shift() as RunRes) : runResult;
    },
    runSync: () => '',
  },
});
const env = {
  worktree_path: '/wt', impl_branch: 'forge/x', base_ref: 'origin/main', base_sha: 'PINSHA',
  implemented: true, diff_stat: ' a.ts | 2 +-', files_changed: ['a.ts'], ci_ok: true, ci_summary: '', last_summary: '',
};
mock.module('../src/gates/gateC.ts', {
  namedExports: { readImplEnvelope: () => env, gateCContext: () => 'Tech design: build X' },
});
mock.module('../src/projects.ts', {
  namedExports: {
    projectForSession: () => ({
      id: 'p', root: '/proj', repos: ['.'], repoPath: () => '/proj/repo',
      scripts: { create_pr: './tools/scripts/forge-create-pr.sh', ci: './tools/scripts/forge-ci.sh', worktree_add: './tools/scripts/wt.sh' },
    }),
  },
});

const sessions = await import('../src/store/sessions.ts');
const gateD = await import('../src/gates/gateD.ts');
const { mkLeg } = await import('../src/gates/legs.ts');

let n = 0;
async function mk(): Promise<string> {
  const id = `pr${++n}`;
  await sessions.create({ id, slug: id, title: 'fix the dropped login session', branch: 'main' });
  return id;
}

beforeEach(() => {
  runCalls = [];
  runResult = { code: 0, stdout: '', stderr: '', timedOut: false };
  runQueue = [];
});

test('openReviewPr: delegates to forge-create-pr.sh (cwd = worktree, --base = branch) and persists the PR URL parsed from the last line', async () => {
  runResult = { code: 0, stdout: 'pushing the branch...\nhttps://github.com/your-org/x/pull/42\n', stderr: '', timedOut: false };
  const id = await mk();
  await gateD.openReviewPr((await sessions.get(id))!);
  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].bin, 'bash');
  assert.equal(runCalls[0].cwd, '/wt');
  assert.equal(runCalls[0].args[0], '/wt/tools/scripts/forge-create-pr.sh'); // resolved relative to the worktree
  assert.ok(runCalls[0].args.includes('--base'));
  assert.equal(runCalls[0].args[runCalls[0].args.indexOf('--base') + 1], 'main');
  const s = (await sessions.get(id))!;
  assert.equal(s.pr_url, 'https://github.com/your-org/x/pull/42');
  assert.equal(s.pr_number, 42);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gated_pr_opened'));
});

test('openReviewPr: a non-zero exit from the script -> throw (the worker parks at GATE_D_FAILED)', async () => {
  runResult = { code: 1, stdout: '', stderr: 'gh auth required', timedOut: false };
  await assert.rejects(async () => gateD.openReviewPr((await sessions.get(await mk()))!), /failed to open the PR/);
});

test('openReviewPr: exit 0 but the last line is not a URL -> throw (never silently record an empty pr_url)', async () => {
  runResult = { code: 0, stdout: 'created it but forgot to print the url', stderr: '', timedOut: false };
  const id = await mk();
  await assert.rejects(async () => gateD.openReviewPr((await sessions.get(id))!), /did not print a PR URL on its last line/);
  assert.equal((await sessions.get(id))!.pr_url, null); // nothing empty was written
});

test('openReviewPr: a pr_url already exists (re-entry after a crash between the patch and the transition) -> the script is not called again (a URL already held locally must not be written outward twice)', async () => {
  const id = await mk();
  await sessions.patch(id, { pr_url: 'https://github.com/your-org/x/pull/7', pr_number: 7 });
  await gateD.openReviewPr((await sessions.get(id))!);
  assert.equal(runCalls.length, 0); // returns early and never calls create_pr again
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gated_pr_reused'));
});

// -- Multi-repo "one repo, one tree, one PR": openReviewPr opens a PR for every leg that has a worktree, and
//    each URL lands on its own leg --
test('openReviewPr (multi-repo): one PR per leg, each URL on its own leg, and session.pr_url = the primary (backward compatibility)', async () => {
  const id = await mk();
  await sessions.patch(id, {
    legs: JSON.stringify([
      mkLeg('demo', { worktree_path: '/wt/demo', impl_branch: 'forge/k', base_sha: 'C' }),
      mkLeg('example-web', { worktree_path: '/wt/example', impl_branch: 'forge/k', base_sha: 'U' }),
    ]),
  });
  runQueue = [
    { code: 0, stdout: 'push...\nhttps://github.com/your-org/demo/pull/11\n', stderr: '', timedOut: false },
    { code: 0, stdout: 'push...\nhttps://github.com/your-org/example-web/pull/22\n', stderr: '', timedOut: false },
  ];
  await gateD.openReviewPr((await sessions.get(id))!);
  assert.equal(runCalls.length, 2); // one PR creation per repo
  assert.equal(runCalls[0].cwd, '/wt/demo'); // each runs with its own worktree as cwd
  assert.equal(runCalls[1].cwd, '/wt/example');
  const legs = JSON.parse((await sessions.get(id))!.legs!);
  assert.equal(legs[0].pr_url, 'https://github.com/your-org/demo/pull/11');
  assert.equal(legs[0].pr_number, 11);
  assert.equal(legs[1].pr_url, 'https://github.com/your-org/example-web/pull/22');
  assert.equal(legs[1].pr_number, 22);
  assert.equal((await sessions.get(id))!.pr_url, 'https://github.com/your-org/demo/pull/11'); // the primary, for backward compatibility
});

test('openReviewPr (multi-repo): idempotent - legs that already have a PR are skipped and only the missing ones are opened (safe to re-enter after a crash)', async () => {
  const id = await mk();
  await sessions.patch(id, {
    legs: JSON.stringify([
      mkLeg('demo', { worktree_path: '/wt/demo', base_sha: 'C', pr_url: 'https://github.com/your-org/demo/pull/11', pr_number: 11 }),
      mkLeg('example-web', { worktree_path: '/wt/example', base_sha: 'U' }),
    ]),
  });
  runQueue = [{ code: 0, stdout: 'https://github.com/your-org/example-web/pull/22\n', stderr: '', timedOut: false }];
  await gateD.openReviewPr((await sessions.get(id))!);
  assert.equal(runCalls.length, 1); // called once, only for example-web which had no PR yet
  assert.equal(runCalls[0].cwd, '/wt/example');
  const legs = JSON.parse((await sessions.get(id))!.legs!);
  assert.equal(legs[1].pr_url, 'https://github.com/your-org/example-web/pull/22');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gated_pr_reused')); // the demo leg was reused
});
