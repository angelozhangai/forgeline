// workspace.ts is the typed wrapper that calls the target project's scripts rather than reimplementing them,
// so the logic it really owns is **building the command and parsing the output**: assembling the flags
// (flag / commonFlags), parseIssues deduplicating and pulling out several repos, and the JSON parsing plus
// UNKNOWN fallback in issueStates / listEpicChildren. proc.run is mocked to capture (bin, args, opts) and
// asserted on directly -- nothing shells out.
// (The Feishu document calls moved to src/docs/feishu.ts, and their tests moved to docs-feishu.test.ts.)
// (commitDeliveryDocs has its own commit-delivery-docs.test.ts and is not repeated here.)
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

interface Call {
  bin: string;
  args: string[];
  opts: Record<string, unknown>;
}
type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean };
const calls: Call[] = [];
let responder: (bin: string, args: string[]) => RunResult = () => ({ code: 0, stdout: '', stderr: '', timedOut: false });

mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (bin: string, args: string[], opts: Record<string, unknown> = {}) => {
      calls.push({ bin, args, opts });
      return responder(bin, args);
    },
  },
});
const ws = await import('../src/workspace.ts');

function reset(r?: (bin: string, args: string[]) => RunResult): void {
  calls.length = 0;
  responder = r ?? (() => ({ code: 0, stdout: '', stderr: '', timedOut: false }));
}
const last = (): Call => calls[calls.length - 1];
// Read a flag's value from the `--name value` form; undefined when it is absent.
const valOf = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// -- Building the arguments, omitting flags, and routing through scriptsDir ------------------
test('reviewReqScaffold: builds the scaffold arguments, omits empty and null flags, appends force and dryRun, and routes through scriptsDir', async () => {
  reset();
  await ws.reviewReqScaffold({ slug: 's1', prd: 'P', repos: 'C,U', issues: '', owner: null, title: 'T', force: true, dryRun: true, scriptsDir: '/sd' });
  const c = last();
  assert.equal(c.bin, 'bash');
  assert.equal(c.args[0], '/sd/review-req.sh'); // routed through scriptsDir, with the script's own name
  const rest = c.args.slice(1);
  assert.deepEqual(rest.slice(0, 2), ['scaffold', 's1']);
  assert.equal(valOf(rest, '--prd'), 'P');
  assert.equal(valOf(rest, '--repos'), 'C,U');
  assert.equal(valOf(rest, '--title'), 'T');
  assert.ok(!rest.includes('--issues'), 'an empty issues string should be omitted');
  assert.ok(!rest.includes('--owner'), 'a null owner should be omitted');
  assert.ok(rest.includes('--force') && rest.includes('--dry-run'));
});

test('reviewReqScaffold: with no scriptsDir it falls back to the default project\'s SCRIPTS_DIR, and the script name is still right', async () => {
  reset();
  await ws.reviewReqScaffold({ slug: 's' });
  assert.match(last().args[0], /[/\\]review-req\.sh$/);
  assert.ok(last().args[0].includes('/'), 'it is a resolved absolute path');
  const rest = last().args.slice(1);
  assert.ok(!rest.includes('--force') && !rest.includes('--dry-run')); // neither is appended by default
});

test('techDesignScaffold: goes through tech-design.sh (the same shape as reviewReq, only the script name differs)', async () => {
  reset();
  await ws.techDesignScaffold({ slug: 's', dryRun: true, scriptsDir: '/sd' });
  assert.equal(last().args[0], '/sd/tech-design.sh');
  assert.deepEqual(last().args.slice(1, 3), ['scaffold', 's']);
  assert.ok(last().args.includes('--dry-run'));
});

test('techDesignApprove: approve <slug> with --issue and --rollup; rollup=false or an empty issue omits them', async () => {
  reset();
  await ws.techDesignApprove('sl', '42', true, '/sd');
  let rest = last().args.slice(1);
  assert.deepEqual(rest.slice(0, 2), ['approve', 'sl']);
  assert.equal(valOf(rest, '--issue'), '42');
  assert.ok(rest.includes('--rollup'));

  reset();
  await ws.techDesignApprove('sl');
  rest = last().args.slice(1);
  assert.ok(!rest.includes('--rollup'), 'rollup=false does not add --rollup');
  assert.ok(!rest.includes('--issue'), 'an empty issue is omitted');
});

test('publishTechDesign: <slug> with --base and dryRun, through publish-tech-design.sh', async () => {
  reset();
  await ws.publishTechDesign('sl', { base: 'main', dryRun: true, scriptsDir: '/sd' });
  assert.match(last().args[0], /publish-tech-design\.sh$/);
  const rest = last().args.slice(1);
  assert.deepEqual(rest.slice(0, 1), ['sl']);
  assert.equal(valOf(rest, '--base'), 'main');
  assert.ok(rest.includes('--dry-run'));
});

// -- commonFlags and parseIssues ---------------------------------------------
test('newReqSingle: single <repo> --title plus commonFlags (a numeric status becomes a string, nulls are omitted), and the created issue is parsed out', async () => {
  reset(() => ({ code: 0, stdout: 'created https://github.com/your-org/demo/issues/12\n', stderr: '', timedOut: false }));
  const r = await ws.newReqSingle('demo', 'a title', { type: 'feature', prio: null, status: 31, assignee: 'az', scriptsDir: '/sd' });
  const rest = last().args.slice(1);
  assert.deepEqual(rest.slice(0, 2), ['single', 'demo']);
  assert.equal(valOf(rest, '--title'), 'a title');
  assert.equal(valOf(rest, '--type'), 'feature');
  assert.equal(valOf(rest, '--status'), '31', 'a numeric status is turned into a string');
  assert.equal(valOf(rest, '--assignee'), 'az');
  assert.ok(!rest.includes('--prio'), 'a null prio is omitted');
  assert.deepEqual(r.issues, [{ repo: 'demo', number: 12, url: 'https://github.com/your-org/demo/issues/12' }]);
});

test('newReqEpic: epic <slug> with one --child repo:title per child; parseIssues deduplicates and picks up only the your-org repos', async () => {
  const stdout = [
    'https://github.com/your-org/demo/issues/1',
    'https://github.com/your-org/demo/issues/1', // a repeat -> deduplicated
    'https://github.com/your-org/example-admin/issues/9',
    'https://github.com/other/repo/issues/5', // a different owner -> not picked up
  ].join('\n');
  reset(() => ({ code: 0, stdout, stderr: '', timedOut: false }));
  const r = await ws.newReqEpic('ep', 'an Epic title', [{ repo: 'C', title: 'a' }, { repo: 'U', title: 'b' }], {});
  const rest = last().args.slice(1);
  assert.deepEqual(rest.slice(0, 2), ['epic', 'ep']);
  const childVals: string[] = [];
  for (let i = 0; i < rest.length; i++) if (rest[i] === '--child') childVals.push(rest[i + 1]);
  assert.deepEqual(childVals, ['C:a', 'U:b']);
  assert.deepEqual(r.issues, [
    { repo: 'demo', number: 1, url: 'https://github.com/your-org/demo/issues/1' },
    { repo: 'example-admin', number: 9, url: 'https://github.com/your-org/example-admin/issues/9' },
  ]);
});

// -- The gh wrappers: addLabel / listEpicChildren / issueStates ---------------------
test('addLabel: gh issue edit <n> -R your-org/<repo> --add-label; a failure gives ok:false with the stderr', async () => {
  reset(() => ({ code: 0, stdout: '', stderr: '', timedOut: false }));
  let r = await ws.addLabel('demo', 7, 'size:M');
  assert.equal(last().bin, 'gh');
  assert.deepEqual(last().args, ['issue', 'edit', '7', '-R', 'your-org/demo', '--add-label', 'size:M']);
  assert.equal(r.ok, true);

  reset(() => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false }));
  r = await ws.addLabel('demo', 7, 'x');
  assert.equal(r.ok, false);
  assert.equal(r.stderr, 'boom');
});

test('listEpicChildren: gh --json is parsed into issues, queried by the epic:<slug> label; bad JSON gives ok:false', async () => {
  reset(() => ({ code: 0, stdout: '[{"number":3,"url":"https://github.com/your-org/demo/issues/3"}]', stderr: '', timedOut: false }));
  let r = await ws.listEpicChildren('demo', 'ep');
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, [{ repo: 'demo', number: 3, url: 'https://github.com/your-org/demo/issues/3' }]);
  assert.equal(valOf(last().args, '-l'), 'epic:ep');
  assert.equal(valOf(last().args, '-R'), 'your-org/demo');

  reset(() => ({ code: 0, stdout: 'not json', stderr: '', timedOut: false }));
  r = await ws.listEpicChildren('demo', 'ep');
  assert.equal(r.ok, false, 'bad JSON is never an empty success -- it is an explicit ok:false');
});

test('issueStates: maps state and reason; bad JSON or a non-zero exit gives UNKNOWN with an empty reason (unreadable is never treated as merged)', async () => {
  let i = 0;
  reset(() => {
    i++;
    if (i === 1) return { code: 0, stdout: '{"state":"CLOSED","stateReason":"COMPLETED"}', stderr: '', timedOut: false };
    return { code: 0, stdout: 'broken', stderr: '', timedOut: false }; // the second one is bad JSON
  });
  const rows = await ws.issueStates([{ repo: 'demo', number: 1, url: 'u' }, { repo: 'demo', number: 2, url: 'u' }]);
  assert.deepEqual(rows[0], { repo: 'demo', number: 1, state: 'CLOSED', reason: 'COMPLETED' });
  assert.deepEqual(rows[1], { repo: 'demo', number: 2, state: 'UNKNOWN', reason: '' });

  reset(() => ({ code: 1, stdout: '', stderr: 'x', timedOut: false })); // gh exits non-zero
  const r2 = await ws.issueStates([{ repo: 'c', number: 9, url: 'u' }]);
  assert.equal(r2[0].state, 'UNKNOWN');
  assert.equal(r2[0].reason, '');
});

// -- The owner is configurable, for a non-default project whose repo lives in another GitHub org ----------
test('the owner is threaded through: newReqEpic, addLabel and listEpicChildren all resolve against the owner passed in, with your-org no longer hard-coded', async () => {
  // parseIssues builds its pattern from the owner passed in: only that org is picked up, and your-org is the
  // one excluded.
  const stdout = ['https://github.com/acme/your-monorepo/issues/7', 'https://github.com/your-org/demo/issues/1'].join('\n');
  reset(() => ({ code: 0, stdout, stderr: '', timedOut: false }));
  const r = await ws.newReqEpic('ep', 'T', [{ repo: 'C', title: 'a' }], { owner: 'acme' });
  assert.deepEqual(r.issues, [{ repo: 'your-monorepo', number: 7, url: 'https://github.com/acme/your-monorepo/issues/7' }]);

  reset(() => ({ code: 0, stdout: '', stderr: '', timedOut: false }));
  await ws.addLabel('your-monorepo', 7, 'size:M', 'acme');
  assert.deepEqual(last().args, ['issue', 'edit', '7', '-R', 'acme/your-monorepo', '--add-label', 'size:M']);

  reset(() => ({ code: 0, stdout: '[]', stderr: '', timedOut: false }));
  await ws.listEpicChildren('your-monorepo', 'ep', 'acme');
  assert.equal(valOf(last().args, '-R'), 'acme/your-monorepo');
});
