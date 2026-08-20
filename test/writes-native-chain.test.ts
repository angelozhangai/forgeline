// 回归：actions:native 项目走真实 GateB → doWrites → native adapter 的**生产链**（不只 adapter 单测）。
// 守两条 review blocker：
//  1) 单仓短码 C 必须经 repoMap 映射成真实仓名 → gh -R acme/your-monorepo（绝不 acme/C）。
//  2) native 下 publish/approve 是 no-op，单仓 GO 能跑完（doWrites 返 ok，绝不 WRITE_FAILED）。
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
      // gh issue create → 回 issue URL（native 据此解 created issue）；gh issue edit 等忽略 stdout。
      return { code: 0, stdout: 'https://github.com/acme/your-monorepo/issues/7\n', stderr: '', timedOut: false };
    },
  },
});

// actions:native 项目：repoMap C→your-monorepo，publish enabled（验 native publish no-op 不挡链）。
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
// biome-ignore lint/suspicious/noExplicitAny: 测试夹具，构造部分 session
function sess(over: Record<string, unknown>): any {
  return { id: 'x', ref_num: 1, slug: 'feat-x', title: 'T', prd_url: null, size: 'M', created_issues: null, assignee: null, ...over };
}

test('actions:native 单仓短码 C → gh issue create -R acme/your-monorepo（已映射），publish/approve no-op，doWrites 返 ok', async () => {
  calls.length = 0;
  const r = await doWrites(sess({ gate_b_draft_path: draft({ issue_specs: [{ repo: 'C', title: 't' }], multi_repo: false }) }));
  assert.equal(r.ok, true, 'native 单仓应跑完（非 WRITE_FAILED）');
  // SF 回归：native publish 是 no-op → r.published=false。actions.go 的 DONE 文案据 r.published，
  // 故 native 走「文档已落，请人工 review」分支，绝不谎称「技术方案已发布主仓…PR 已自动合」。
  assert.equal(r.published, false, 'native 未真发布 → published:false');
  const create = calls.find((c) => c.bin === 'gh' && c.args[0] === 'issue' && c.args[1] === 'create');
  assert.ok(create, '应有 gh issue create 调用');
  assert.equal(create?.args[3], 'acme/your-monorepo', '短码 C 必须映射成真实仓名，不是 acme/C');
  assert.ok(!calls.some((c) => c.args.includes('acme/C')), '绝不出现未映射的 acme/C');
  assert.deepEqual(r.issues, [{ repo: 'your-monorepo', number: 7, url: 'https://github.com/acme/your-monorepo/issues/7' }]);
});
