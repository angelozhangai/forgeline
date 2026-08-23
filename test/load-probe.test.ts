// SF1 regression: the load probe maps the **local repo key/path** (a monorepo's '.') through repoSlugs into a
// GitHub slug before building gh -R, and must never use '.' as a GitHub repo name (which would fail every
// auto-DRI probe for your-monorepo and have GO blocked on "no DRI assigned").
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

interface Call {
  bin: string;
  args: string[];
}
const calls: Call[] = [];
mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (bin: string, args: string[]) => {
      calls.push({ bin, args });
      return { code: 0, stdout: '[]', stderr: '', timedOut: false };
    },
  },
});

const { probeLoad } = await import('../src/util/load.ts');
// biome-ignore lint/suspicious/noExplicitAny: the minimal cfg (probeLoad only reads assignment.pool / in_progress_statuses and routing.reviewers)
const cfg: any = { routing: { reviewers: { M: 'ming' } }, assignment: { pool: ['M'], in_progress_statuses: [3] } };

test("probeLoad: the local monorepo key . goes through repoSlugs -> gh issue list -R owner/your-monorepo (never owner/.)", async () => {
  calls.length = 0;
  await probeLoad(cfg, { owner: 'your-org', repos: ['.'], umbrella: '.', repoSlugs: { '.': 'your-monorepo' }, repoMap: { C: '.' } });
  const lists = calls.filter((c) => c.bin === 'gh' && c.args[0] === 'issue' && c.args[1] === 'list');
  assert.ok(lists.length > 0, 'there should be a gh issue list call');
  for (const c of lists) {
    const r = c.args[c.args.indexOf('-R') + 1];
    assert.equal(r, 'your-org/your-monorepo', `the local '.' must map to your-monorepo, but it was ${r}`);
  }
  assert.ok(!calls.some((c) => c.args.includes('your-org/.')), 'an unmapped owner/. must never appear');
});

test('probeLoad: with no repoSlugs (demo\'s repo names are already the slugs) -> passed through as they are (behaviour unchanged)', async () => {
  calls.length = 0;
  await probeLoad(cfg, { owner: 'your-org', repos: ['demo', 'example-web'], umbrella: 'example-project', repoSlugs: {}, repoMap: { C: 'demo', U: 'example-web' } });
  const slugs = calls.filter((c) => c.bin === 'gh' && c.args[1] === 'list').map((c) => c.args[c.args.indexOf('-R') + 1]);
  assert.deepEqual([...new Set(slugs)].sort(), ['your-org/demo', 'your-org/example-project', 'your-org/example-web']);
});
