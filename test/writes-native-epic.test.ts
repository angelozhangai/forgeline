// 回归：actions:native 项目走 doWrites **多仓 Epic** 生产链（解耦 ✓C#n 输出契约后 native 端到端可用）。
// 守：① Epic→伞仓 + 子 issue→各 code 仓，gh -R 经 repoMap(字母→本地 key)→repoSlugs(→slug) 两跳；
//     ② issues 全程**本地 key** 命名空间 → doWrites 覆盖校验(expectedRepos 也是本地 key)通过、不误判缺子仓；
//     ③ publish/approve no-op 不挡链 → doWrites 返 ok（绝非 WRITE_FAILED）。
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
      // gh issue create → 回该仓的 issue URL（native 据 -R 的 slug 解 created issue，repo 再置回本地 key）。
      const i = args.indexOf('-R');
      const slug = i >= 0 ? String(args[i + 1]).split('/')[1] : 'x';
      return { code: 0, stdout: `https://github.com/acme/${slug}/issues/5\n`, stderr: '', timedOut: false };
    },
  },
});

// 多仓 native：伞仓 umb（本地 key）+ 两 code 仓 web/api（短码 C→web / U→api）。slug=key（repoSlugs 空）。
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
// biome-ignore lint/suspicious/noExplicitAny: 测试夹具，构造部分 session
function sess(over: Record<string, unknown>): any {
  return { id: 'x', ref_num: 1, slug: 'feat-x', title: 'T', prd_url: null, size: 'M', created_issues: null, assignee: null, ...over };
}

const MULTI = { multi_repo: true, epic_title: 'E', issue_specs: [{ repo: 'C', title: 'c' }, { repo: 'U', title: 'u' }] };

test('actions:native 多仓 Epic → doWrites 端到端 ok，issues=Epic+子（本地 key 命名空间），gh -R 经两跳映射', async () => {
  calls.length = 0;
  const created: { repo: string; number: number; url: string }[] = [];
  const r = await doWrites(sess({ gate_b_draft_path: draft(MULTI) }), { onCreated: (iss) => { created.length = 0; created.push(...iss); } });

  assert.equal(r.ok, true, 'native 多仓应跑完（覆盖校验通过、非 WRITE_FAILED）');
  assert.equal(r.published, false, 'native publish no-op → published:false');

  // 三个 gh issue create：伞仓 umb + 两 code 仓 web/api。
  const creates = calls.filter((c) => c.bin === 'gh' && c.args[0] === 'issue' && c.args[1] === 'create');
  assert.deepEqual(creates.map((c) => c.args[c.args.indexOf('-R') + 1]).sort(), ['acme/api', 'acme/umb', 'acme/web']);
  assert.ok(!calls.some((c) => c.args.includes('acme/C') || c.args.includes('acme/U')), '短码不得直传 gh');

  // 覆盖校验在**本地 key** 命名空间：issues 含 umb(伞)+web+api，expectedRepos=[web,api] 全齐。
  assert.deepEqual(r.issues.map((i) => i.repo).sort(), ['api', 'umb', 'web']);
  assert.deepEqual(created.map((i) => i.repo).sort(), ['api', 'umb', 'web'], 'onCreated 落库含 Epic+全部子 issue');

  // size 标签只打 Epic（伞仓 umb）：gh issue edit -R acme/umb。
  const edit = calls.find((c) => c.bin === 'gh' && c.args[0] === 'issue' && c.args[1] === 'edit');
  assert.ok(edit, '应给 Epic 打 size 标签');
  assert.equal(edit?.args[edit.args.indexOf('-R') + 1], 'acme/umb', 'size 标签打在伞仓（本地 key umb → slug umb）');
});
