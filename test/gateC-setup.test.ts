// 集成：runGateCSetup 委托建树的关键不变量——
//  · 建树锚点传**pin 住的 base_sha**（非移动 ref origin/<branch>）：并发/外部 fetch 推进 origin 时不漂基线（Codex B1）。
//  · worktree 路径/分支按 implIdentity（全 id 哈希）派生：同 slug（含长 slug 触顶截断）不同 session 不互删（Codex B 多轮）。
//  · 幂等前清：确定性路径已存在（孤儿）→ 委托 removeWorktree + 删残留分支；否则不动（Codex SF2）。
//  · 精确 repo sha：named repo 缺 key（即便有 '.'）→ 拒建，绝不静默拿错仓 sha（Codex SF）。
// mock 掉 worktree 委托 / repoFreshness / projects；用真 sessions(:memory:)。不起真 git。
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

interface CreateCall { repoDir: string; path: string; branch: string; baseCommitish: string }
let createCalls: CreateCall[] = [];
let removeCalls: { path: string }[] = [];
let deleteBranchCalls: { branch: string }[] = [];
let listResult: string[] = [];
let freshShas: Record<string, string> = { '.': 'PINSHA_AT_REFRESH' };
let projRepos: string[] = ['.'];

mock.module('../src/util/worktree.ts', {
  namedExports: {
    ensureWorktreeExcluded: () => {},
    defaultWorktreePath: (repoDir: string, key: string) => `${repoDir}-forge-${key}`,
    createWorktree: async (o: CreateCall) => {
      createCalls.push(o);
      return { ok: true, path: o.path, branch: o.branch, output: '' };
    },
    removeWorktree: async (o: { path: string }) => {
      removeCalls.push(o);
      return { ok: true, output: '' };
    },
    listWorktrees: (_repoDir: string) => listResult,
    deleteBranch: (_repoDir: string, branch: string) => {
      deleteBranchCalls.push({ branch });
    },
    worktreeHeadSha: () => null,
  },
});
mock.module('../src/gates/repoFreshness.ts', {
  namedExports: {
    refresh: async () => ({ branch: 'main', refsText: '', shas: freshShas }),
    assertFresh: () => {},
  },
});
mock.module('../src/projects.ts', {
  namedExports: {
    projectForSession: () => ({
      id: 'p',
      root: '/proj',
      repos: projRepos,
      repoPath: (r: string) => (r === '.' ? '/proj/repo' : `/proj/${r}`), // 单仓('.')沿用 /proj/repo；多仓各仓各自路径（leg 路径互异）
      scripts: { ci: './tools/scripts/forge-ci.sh', worktree_add: './tools/scripts/wt.sh' },
    }),
  },
});

const sessions = await import('../src/store/sessions.ts');
const gateC = await import('../src/gates/gateC.ts');
const { mkLeg } = await import('../src/gates/legs.ts');

let n = 0;
async function mkSession(slug: string): Promise<string> {
  const id = `${slug}-id${++n}`; // 模拟 intake 的 id=<slug>-<shortId>（唯一）
  await sessions.create({ id, slug, title: 'T', branch: 'main' });
  return id;
}

beforeEach(() => {
  createCalls = [];
  removeCalls = [];
  deleteBranchCalls = [];
  listResult = [];
  freshShas = { '.': 'PINSHA_AT_REFRESH' };
  projRepos = ['.'];
});

test('runGateCSetup：建树锚点传 pin 住的 base_sha（绝非移动 ref origin/main）+ base_shas 落库', async () => {
  const id = await mkSession('fix-login');
  await gateC.runGateCSetup((await sessions.get(id))!);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].baseCommitish, 'PINSHA_AT_REFRESH'); // B1：pin sha
  assert.notEqual(createCalls[0].baseCommitish, 'origin/main'); // 不踩移动 ref
  assert.equal(JSON.parse((await sessions.get(id))!.base_shas!)['.'], 'PINSHA_AT_REFRESH'); // CI/parseFixResult 同基线
});

test('runGateCSetup：路径/分支按 implIdentity 派生 + 落库一致（闸D 开 PR 用同一 impl_branch）', async () => {
  const id = await mkSession('fix-login');
  const expect = gateC.implIdentity('/proj/repo', id);
  await gateC.runGateCSetup((await sessions.get(id))!);
  assert.equal(createCalls[0].path, expect.worktreePath);
  assert.equal(createCalls[0].branch, expect.implBranch);
  assert.equal((await sessions.get(id))!.worktree_path, expect.worktreePath); // 落库即归一后值
  assert.equal((await sessions.get(id))!.impl_branch, expect.implBranch);
});

test('runGateCSetup：同 slug（普通）两条 setup → 路径/分支互异，第二条不删第一条（Codex B1）', async () => {
  const a = await mkSession('dup-title');
  const b = await mkSession('dup-title'); // 同 slug，不同 id
  await gateC.runGateCSetup((await sessions.get(a))!);
  await gateC.runGateCSetup((await sessions.get(b))!);
  assert.notEqual(createCalls[0].path, createCalls[1].path);
  assert.notEqual(createCalls[0].branch, createCalls[1].branch);
  assert.equal(removeCalls.length, 0); // 谁也没碰谁的 worktree
  assert.equal(deleteBranchCalls.length, 0);
});

test('runGateCSetup：长 slug（触顶 slugify 截断）同 slug 两条 setup → 仍不撞、不互删（哈希保唯一，Codex 四审 B）', async () => {
  const slug = 'z'.repeat(45); // > slugify .slice(40)，旧实现会把两条截成同一 key
  const a = await mkSession(slug);
  const b = await mkSession(slug);
  await gateC.runGateCSetup((await sessions.get(a))!);
  await gateC.runGateCSetup((await sessions.get(b))!);
  assert.notEqual(createCalls[0].path, createCalls[1].path); // 哈希区分，旧实现这里会相等
  assert.notEqual(createCalls[0].branch, createCalls[1].branch);
  assert.equal(removeCalls.length, 0); // 第二条没误删第一条的活 worktree
});

test('runGateCSetup：确定性路径已存在孤儿 → 委托 removeWorktree + 删残留分支后重建（SF2）', async () => {
  const id = await mkSession('orphaned');
  const { worktreePath, implBranch } = gateC.implIdentity('/proj/repo', id);
  listResult = [worktreePath]; // 模拟上轮崩在 create 与落 worktree_path 之间的物理孤儿
  await gateC.runGateCSetup((await sessions.get(id))!);
  assert.equal(removeCalls.length, 1);
  assert.equal(removeCalls[0].path, worktreePath);
  assert.deepEqual(deleteBranchCalls, [{ branch: implBranch }]);
  assert.equal(createCalls.length, 1); // 清完照常重建
});

// ── Phase 2a：落 legs（每仓一腿）。单仓恰 1 腿（行为不变）；多仓 primary 建树、其余 pending（2b 再建树+实现）──
test('runGateCSetup：落 legs——单仓 → 恰 1 腿(=primary)，镜像 session worktree + base_sha', async () => {
  const id = await mkSession('one-repo');
  await gateC.runGateCSetup((await sessions.get(id))!);
  const legs = JSON.parse((await sessions.get(id))!.legs!);
  assert.equal(legs.length, 1);
  assert.equal(legs[0].repo, '.');
  assert.equal(legs[0].worktree_path, (await sessions.get(id))!.worktree_path);
  assert.equal(legs[0].base_sha, 'PINSHA_AT_REFRESH');
});

test('runGateCSetup（多仓/2b）：每 target 仓各建一树一腿（base_sha pin 各仓、worktree 路径互异、session 指向 primary）', async () => {
  projRepos = ['demo', 'example-web'];
  freshShas = { demo: 'SHA_C', 'example-web': 'SHA_U' };
  const id = await mkSession('multi-repo');
  await sessions.patch(id, { target_repos: JSON.stringify(['demo', 'example-web']) });
  await gateC.runGateCSetup((await sessions.get(id))!);
  const legs = JSON.parse((await sessions.get(id))!.legs!);
  assert.deepEqual(
    legs.map((l: { repo: string }) => l.repo),
    ['demo', 'example-web'],
  );
  assert.equal(legs[0].base_sha, 'SHA_C'); // 各仓 pin 各自 sha（绝不拿错仓基线）
  assert.equal(legs[1].base_sha, 'SHA_U');
  assert.ok(legs[0].worktree_path && legs[1].worktree_path);
  assert.notEqual(legs[0].worktree_path, legs[1].worktree_path); // 各仓各自 .forge/worktrees/ 隐藏目录
  assert.equal(createCalls.length, 2); // 每仓一次建树
  assert.equal((await sessions.get(id))!.worktree_path, legs[0].worktree_path); // session 指向 primary（顺序驱动起点）
});

test('runGateCSetup（多仓/2b）：某仓 refresh 缺 base sha → 抛（绝不对错仓/移动 ref 建树），不静默建半套', async () => {
  projRepos = ['demo', 'example-web'];
  freshShas = { demo: 'SHA_C' }; // 缺 example-web
  const id = await mkSession('multi-missing-sha');
  await sessions.patch(id, { target_repos: JSON.stringify(['demo', 'example-web']) });
  const s = (await sessions.get(id))!;
  await assert.rejects(() => gateC.runGateCSetup(s), /example-web 的 base sha/);
});

// ── activeLeg / activateLeg：顺序驱动的两个原语（绿一条切下一条）──
test('activeLeg：按 worktree_path 命中当前活跃 leg；否则取首条未绿', () => {
  const legs = [mkLeg('demo', { worktree_path: '/wt/c', ci_ok: true }), mkLeg('example-web', { worktree_path: '/wt/u' })];
  const s = { worktree_path: '/wt/u', legs: JSON.stringify(legs) };
  assert.equal(gateC.activeLeg(s)!.repo, 'example-web'); // 命中 worktree_path
  assert.equal(gateC.activeLeg({ worktree_path: null, legs: JSON.stringify(legs) })!.repo, 'example-web'); // 退而取首条未绿
  assert.equal(gateC.activeLeg({ worktree_path: null, legs: null }), null);
});

test('activateLeg：session 指向该 leg（worktree/分支/base_shas）+ 重置闸C 循环态', async () => {
  const id = await mkSession('activate');
  await sessions.patch(id, { gate_c_round: 3, gate_c_fixer_session: 'old', worktree_path: '/old' });
  await gateC.activateLeg((await sessions.get(id))!, mkLeg('example-web', { worktree_path: '/wt/u', impl_branch: 'forge/k', base_sha: 'SHA_U' }));
  const s = (await sessions.get(id))!;
  assert.equal(s.worktree_path, '/wt/u');
  assert.equal(s.impl_branch, 'forge/k');
  assert.equal(JSON.parse(s.base_shas!)['example-web'], 'SHA_U');
  assert.equal(s.gate_c_round, null); // 切 leg 重置循环态
  assert.equal(s.gate_c_fixer_session, null);
});

test('activateLeg：闸D 重指 leg——带上该 leg 的 pr_url/pr_number + 重置闸D 全套循环态（绝不把上条 leg 的审/补强带歪下条）', async () => {
  const id = await mkSession('activate-d');
  // 模拟上一条 leg 跑完闸D 残留的 session 级闸D 态
  await sessions.patch(id, {
    gate_d_round: 2, gate_d_reviewer_session: 'codex-old', gate_d_fixer_session: 'cl-old',
    gate_d_green_sha: 'OLDGREEN', gate_d_harden_round: 1, gate_d_harden_verified_sha: 'OLDV',
    merge_readiness_path: '/old/mr.md', pr_url: 'OLD_PR', pr_number: 1,
  });
  await gateC.activateLeg((await sessions.get(id))!, mkLeg('example-web', { worktree_path: '/wt/u', impl_branch: 'forge/k', base_sha: 'SHA_U', pr_url: 'NEW_PR', pr_number: 22 }));
  const s = (await sessions.get(id))!;
  assert.equal(s.pr_url, 'NEW_PR'); // 指向该 leg 的 PR（审/合并/通知都对齐它）
  assert.equal(s.pr_number, 22);
  assert.equal(s.gate_d_round, null); // 闸D 循环态全归零
  assert.equal(s.gate_d_reviewer_session, null);
  assert.equal(s.gate_d_fixer_session, null);
  assert.equal(s.gate_d_green_sha, null);
  assert.equal(s.gate_d_harden_round, null);
  assert.equal(s.gate_d_harden_verified_sha, null);
  assert.equal(s.merge_readiness_path, null);
});

test('runGateCSetup：无孤儿 → 不删（前清只在路径已存在时触发）', async () => {
  const id = await mkSession('clean');
  await gateC.runGateCSetup((await sessions.get(id))!);
  assert.equal(removeCalls.length, 0);
  assert.equal(deleteBranchCalls.length, 0);
});

test('runGateCSetup：refresh 未给 base sha → 抛（拒绝对移动 ref pin），不建树', async () => {
  freshShas = {}; // refresh 没返回任何 sha
  const id = await mkSession('no-sha');
  const s = (await sessions.get(id))!;
  await assert.rejects(() => gateC.runGateCSetup(s), /无法 pin 工作树基线/);
  assert.equal(createCalls.length, 0);
});

test('runGateCSetup：named repo 缺 key 但有 "." → 抛（精确读本仓 sha，绝不静默拿 "."，Codex SF）', async () => {
  projRepos = ['libs']; // repo !== '.'
  freshShas = { '.': 'sha-for-dot' }; // 只有 '.'，缺 'libs'
  const id = await mkSession('named-repo');
  const s = (await sessions.get(id))!;
  await assert.rejects(() => gateC.runGateCSetup(s), /无法 pin 工作树基线/);
  assert.equal(createCalls.length, 0);
});
