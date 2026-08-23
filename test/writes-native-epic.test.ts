// A regression test: an actions:native project going through doWrites' **multi-repo Epic** production chain,
// which became usable end to end once the ✓C#n output contract was decoupled. What it guards:
//  1. the Epic goes to the umbrella repo and each child to its own code repo, with gh -R taking both hops --
//     repoMap (letter to local key) then repoSlugs (local key to slug);
//  2. the issues stay in the **local key** namespace throughout, so doWrites' coverage check (whose
//     expectedRepos are local keys too) passes and never wrongly reports a missing child repo;
//  3. publish and approve being no-ops does not block the chain, so doWrites returns ok rather than
//     WRITE_FAILED.
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
      // gh issue create returns that repo's issue URL; native resolves the created issue by the slug in -R and
      // then puts repo back to the local key.
      const i = args.indexOf('-R');
      const slug = i >= 0 ? String(args[i + 1]).split('/')[1] : 'x';
      return { code: 0, stdout: `https://github.com/acme/${slug}/issues/5\n`, stderr: '', timedOut: false };
    },
  },
});

// Native across several repos: the umbrella repo umb (a local key) plus two code repos, web and api (short
// codes C -> web and U -> api). The slug equals the key, since repoSlugs is empty.
const nativeProj = {
  id: 'comp',
  root: '/tmp/forge-native-epic',
  scriptsDir: '/tmp/forge-native-epic/scripts',
  deliveryDir: '/tmp/forge-native-epic/docs/delivery',
  repoPath: (r: string) => `/tmp/forge-native-epic/${r}`,
  looksValid: () => true,
  repos: ['web', 'api'],
  owner: 'acme',
  actions: 'native',
  branches: { prod: 'main', dev: 'dev' },
  defaultBranch: 'prod',
  techDesignPublish: { enabled: true, base: 'main' },
  repoMap: { C: 'web', U: 'api' },
  repoSlugs: {},
  umbrella: 'umb',
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

const DIR = mkdtempSync(resolve(tmpdir(), 'forge-native-epic-'));
function draft(env: unknown): string {
  const p = resolve(DIR, 'draft.json');
  writeFileSync(p, JSON.stringify(env));
  return p;
}
// biome-ignore lint/suspicious/noExplicitAny: a test fixture building a partial session
function sess(over: Record<string, unknown>): any {
  return { id: 'x', ref_num: 1, slug: 'feat-x', title: 'T', prd_url: null, size: 'M', created_issues: null, assignee: null, ...over };
}

const MULTI = { multi_repo: true, epic_title: 'E', issue_specs: [{ repo: 'C', title: 'c' }, { repo: 'U', title: 'u' }] };

test('actions:native with a multi-repo Epic: doWrites is ok end to end, issues are the Epic plus its children in the local-key namespace, and gh -R is mapped through both hops', async () => {
  calls.length = 0;
  const created: { repo: string; number: number; url: string }[] = [];
  const r = await doWrites(sess({ gate_b_draft_path: draft(MULTI) }), { onCreated: (iss) => { created.length = 0; created.push(...iss); } });

  assert.equal(r.ok, true, 'native across several repos should run to completion, passing the coverage check rather than parking as WRITE_FAILED');
  assert.equal(r.published, false, 'native publish no-op → published:false');

  // Three gh issue create calls: the umbrella repo umb plus the two code repos, web and api.
  const creates = calls.filter((c) => c.bin === 'gh' && c.args[0] === 'issue' && c.args[1] === 'create');
  assert.deepEqual(creates.map((c) => c.args[c.args.indexOf('-R') + 1]).sort(), ['acme/api', 'acme/umb', 'acme/web']);
  assert.ok(!calls.some((c) => c.args.includes('acme/C') || c.args.includes('acme/U')), 'a short code must never be passed straight to gh');

  // The coverage check runs in the **local key** namespace: the issues cover umb (the umbrella) plus web and
  // api, and expectedRepos=[web, api] is fully satisfied.
  assert.deepEqual(r.issues.map((i) => i.repo).sort(), ['api', 'umb', 'web']);
  assert.deepEqual(created.map((i) => i.repo).sort(), ['api', 'umb', 'web'], 'what onCreated persists covers the Epic and every child issue');

  // The size label goes on the Epic only, in the umbrella repo umb: gh issue edit -R acme/umb.
  const edit = calls.find((c) => c.bin === 'gh' && c.args[0] === 'issue' && c.args[1] === 'edit');
  assert.ok(edit, 'the Epic should get a size label');
  assert.equal(edit?.args[edit.args.indexOf('-R') + 1], 'acme/umb', 'the size label lands on the umbrella repo (local key umb -> slug umb)');
});
