// Unit tests for maybeCommitDeliveryDocs: the config gate, and the real enabled branch. Switched on, it
// delegates to commitDeliveryDocs to run git (add, diff, commit), **never pushes**, and returns committed;
// switched off it is a plain no-op that never touches git. git is intercepted by the proc mock, so no real
// git process runs, and the gate reads the mocked config.
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let deliveryEnabled = true;
// A complete cfg, enough for defaultProject to read runtime while root.ts and project.ts load;
// delivery_doc_commit is decided dynamically by deliveryEnabled.
const base = {
  poll_interval_sec: 180, max_parallel: 2, branches: { prod: 'main', dev: 'dev' }, default_branch: 'prod',
  repos: ['demo'], adversarial: { reviewer: 'codex', on_missing: 'skip', max_rounds: 3 },
  claude_bin: 'claude', codex_bin: 'codex', claude_allowed_tools: '', claude_timeout_sec: 1,
};
function cfg() {
  return {
    runtime: { ...base, delivery_doc_commit: { enabled: deliveryEnabled } },
    routing: { min_confidence: 0.7, sensitive_areas: [], reviewers: {}, lead: 'M' },
    permissions: { gate_b_allowed: ['M'], go_approvers: ['M'], operators: {} },
    assignment: { pool: ['M'], wip_limit: { default: 2 }, in_progress_statuses: [3] },
    projects: null, env: {},
  };
}
mock.module('../src/config.ts', {
  namedExports: { loadConfig: cfg, resolveLogin: () => null, inAllowList: () => true },
});
// configForProject and configForSession are stubbed to the same controlled config -- writes.ts imports
// configForSession, so without a stub the module fails to link.
mock.module('../src/projects.ts', {
  namedExports: { projectForSession: () => ({ root: '/proj' }), project: () => ({ root: '/proj' }), defaultProjectId: () => 'p', configForProject: cfg, configForSession: cfg },
});
// Intercepting git: add exits 0; diff --cached --quiet exits 1, meaning that path did change and should be
// committed; commit exits 0. Flipping diffCode covers the "nothing changed, so skip" case.
let calls: string[][] = [];
let diffCode = 1;
mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (_bin: string, args: string[]) => {
      calls.push(args);
      const code = args.includes('add') ? 0 : args.includes('diff') ? diffCode : 0;
      return { code, stdout: '', stderr: '', timedOut: false };
    },
    runSync: () => '',
    commandExists: () => true,
  },
});

const { maybeCommitDeliveryDocs } = await import('../src/writes.ts');

const S = { id: 's1', slug: 'feat-x', ref_num: 7 } as never;

beforeEach(() => { calls = []; diffCode = 1; deliveryEnabled = true; });

test('switched on with changes: it delegates to git to commit docs/delivery/<slug>, never pushes, and returns committed:true', async () => {
  const r = await maybeCommitDeliveryDocs(S);
  assert.deepEqual(r, { ok: true, committed: true });
  assert.ok(calls.some((c) => c.includes('commit') && c.includes('docs/delivery/feat-x')), 'the commit is limited to the document pathspec');
  assert.ok(calls.every((c) => c.includes('-C') && c.includes('/proj')), 'every git call is -C the target project root');
  assert.ok(!calls.some((c) => c.includes('push')), 'it never pushes');
});

test('switched on with nothing changed (diff exits 0): it skips idempotently, returning committed:false without committing', async () => {
  diffCode = 0;
  const r = await maybeCommitDeliveryDocs(S);
  assert.deepEqual(r, { ok: true, committed: false });
  assert.ok(!calls.some((c) => c.includes('commit')));
});

test('switched off, which is the default: a plain no-op returning committed:false, never touching git at all', async () => {
  deliveryEnabled = false;
  const r = await maybeCommitDeliveryDocs(S);
  assert.deepEqual(r, { ok: true, committed: false });
  assert.equal(calls.length, 0, 'with the gate off, no git call is made at all');
});
