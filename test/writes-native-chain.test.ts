// A regression test: an actions:native project through the **real production chain** gate B -> doWrites ->
// the native adapter, rather than a unit test of the adapter alone.
// It guards the two blockers a review found:
//  1) the single-repo short code C has to be mapped through repoMap to the real repo name, so gh gets
//     -R acme/your-monorepo and never acme/C;
//  2) natively, publish and approve are no-ops, so a single-repo go still runs to completion -- doWrites
//     returns ok and never parks as WRITE_FAILED.
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

interface Call {
  bin: string;
  args: string[];
}
const calls: Call[] = [];
mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (bin: string, args: string[]) => {
      calls.push({ bin, args });
      // gh issue create returns the issue URL, which is what native resolves the created issue from; gh issue
      // edit and the rest ignore stdout.
      return { code: 0, stdout: 'https://github.com/acme/your-monorepo/issues/7\n', stderr: '', timedOut: false };
    },
  },
});

// An actions:native project: repoMap maps C -> your-monorepo, with publish enabled, to prove that native's
// no-op publish does not block the chain.
const nativeProj = {
  id: 'comp',
  root: '/tmp/forge-native-x',
  scriptsDir: '/tmp/forge-native-x/scripts',
  deliveryDir: '/tmp/forge-native-x/docs/delivery',
  repoPath: (r: string) => `/tmp/forge-native-x/${r}`,
  looksValid: () => true,
  repos: ['your-monorepo'],
  owner: 'acme',
  actions: 'native',
  branches: { prod: 'main', dev: 'dev' },
  defaultBranch: 'prod',
  techDesignPublish: { enabled: true, base: 'main' },
  repoMap: { C: 'your-monorepo' },
  repoSlugs: {},
  umbrella: 'your-monorepo',
  scripts: {},
  autonomy: { level: 0, actor: 'M' },
};
mock.module('../src/projects.ts', {
  namedExports: {
    projectForSession: () => nativeProj,
    configForSession: () => ({ routing: { reviewers: {} } }),
    project: () => nativeProj,
    DEFAULT_OWNER: 'your-org',
  },
});

const { doWrites } = await import('../src/writes.ts');

const DIR = mkdtempSync(resolve(tmpdir(), 'forge-native-chain-'));
function draft(env: unknown): string {
  const p = resolve(DIR, 'draft.json');
  writeFileSync(p, JSON.stringify(env));
  return p;
}
// biome-ignore lint/suspicious/noExplicitAny: a test fixture building a partial session
function sess(over: Record<string, unknown>): any {
  return { id: 'x', ref_num: 1, slug: 'feat-x', title: 'T', prd_url: null, size: 'M', created_issues: null, assignee: null, ...over };
}

test('actions:native with the single-repo short code C: gh issue create gets -R acme/your-monorepo (mapped), publish and approve are no-ops, and doWrites returns ok', async () => {
  calls.length = 0;
  const r = await doWrites(sess({ gate_b_draft_path: draft({ issue_specs: [{ repo: 'C', title: 't' }], multi_repo: false }) }));
  assert.equal(r.ok, true, 'a native single-repo run should complete rather than parking as WRITE_FAILED');
  // A regression guard: natively publish is a no-op, so r.published is false. actions.go's DONE copy reads
  // r.published, so natively it takes the "the document is written, please review it by hand" branch and
  // never claims the technical plan was published to the main repo and its PR merged automatically.
  assert.equal(r.published, false, 'nothing was really published natively -> published:false');
  const create = calls.find((c) => c.bin === 'gh' && c.args[0] === 'issue' && c.args[1] === 'create');
  assert.ok(create, 'there should be a gh issue create call');
  assert.equal(create?.args[3], 'acme/your-monorepo', 'the short code C has to be mapped to the real repo name, not left as acme/C');
  assert.ok(!calls.some((c) => c.args.includes('acme/C')), 'an unmapped acme/C must never appear');
  assert.deepEqual(r.issues, [{ repo: 'your-monorepo', number: 7, url: 'https://github.com/acme/your-monorepo/issues/7' }]);
});
