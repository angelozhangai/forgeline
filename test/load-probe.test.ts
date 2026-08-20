// SF1 回归：负载探测把**本地 repo key/path**（monorepo '.'）经 repoSlugs 映射成 GitHub slug 再拼 gh -R，
// 绝不把 '.' 当 GitHub 仓名（否则 your-monorepo 的 auto DRI 探测全失败、GO 被「未指派 DRI」挡）。
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
// biome-ignore lint/suspicious/noExplicitAny: 最小 cfg（probeLoad 只用 assignment.pool/in_progress_statuses + routing.reviewers）
const cfg: any = { routing: { reviewers: { M: 'ming' } }, assignment: { pool: ['M'], in_progress_statuses: [3] } };

test('probeLoad：本地 monorepo key . 经 repoSlugs → gh issue list -R owner/your-monorepo（绝不 owner/.）', async () => {
  calls.length = 0;
  await probeLoad(cfg, { owner: 'your-org', repos: ['.'], umbrella: '.', repoSlugs: { '.': 'your-monorepo' }, repoMap: { C: '.' } });
  const lists = calls.filter((c) => c.bin === 'gh' && c.args[0] === 'issue' && c.args[1] === 'list');
  assert.ok(lists.length > 0, '应有 gh issue list 调用');
  for (const c of lists) {
    const r = c.args[c.args.indexOf('-R') + 1];
    assert.equal(r, 'your-org/your-monorepo', `本地 '.' 必映射成 your-monorepo，实得 ${r}`);
  }
  assert.ok(!calls.some((c) => c.args.includes('your-org/.')), '绝不出现未映射的 owner/.');
});

test('probeLoad：无 repoSlugs（demo 仓名即 slug）→ 原样（行为不变）', async () => {
  calls.length = 0;
  await probeLoad(cfg, { owner: 'your-org', repos: ['demo', 'example-web'], umbrella: 'example-project', repoSlugs: {}, repoMap: { C: 'demo', U: 'example-web' } });
  const slugs = calls.filter((c) => c.bin === 'gh' && c.args[1] === 'list').map((c) => c.args[c.args.indexOf('-R') + 1]);
  assert.deepEqual([...new Set(slugs)].sort(), ['your-org/demo', 'your-org/example-project', 'your-org/example-web']);
});
