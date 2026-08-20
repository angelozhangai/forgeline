// 单测：worktree.ts 委托式工作树生命周期。mock 掉 proc 的 run/runSync，断言委托的 bin/args 正确、
// 失败不抛只返回 ok:false、孤儿列举/HEAD 查询出错时降级不冒进。不起真 git 进程。
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface RunCall {
  bin: string;
  args: string[];
  cwd?: string;
}
let runCalls: RunCall[] = [];
let runResult = { code: 0, stdout: '', stderr: '', timedOut: false };
let syncOut = '';
let syncThrow = false;
let syncCalls: string[][] = [];

mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (bin: string, args: string[], opts: { cwd?: string } = {}) => {
      runCalls.push({ bin, args, cwd: opts.cwd });
      return runResult;
    },
    runSync: (_bin: string, args: string[]) => {
      syncCalls.push(args);
      if (syncThrow) throw new Error('git boom');
      return syncOut;
    },
  },
});

const { defaultWorktreePath, worktreeRoot, ensureWorktreeExcluded, createWorktree, removeWorktree, listWorktrees, worktreeHeadSha, deleteBranch, planWorktreeSweep } =
  await import('../src/util/worktree.ts');

beforeEach(() => {
  runCalls = [];
  runResult = { code: 0, stdout: 'ok', stderr: '', timedOut: false };
  syncOut = '';
  syncThrow = false;
  syncCalls = [];
});

test('defaultWorktreePath：落该仓隐藏目录 .forge/worktrees/<key>（顶层规则：worktree 归属具体仓、不堆 umbrella）', () => {
  assert.equal(worktreeRoot('/ws/your-monorepo'), '/ws/your-monorepo/.forge/worktrees');
  const p = defaultWorktreePath('/ws/your-monorepo', 'fix-login');
  assert.equal(p, '/ws/your-monorepo/.forge/worktrees/fix-login');
});

test('createWorktree（委托 wt.sh）：bash <script> <path> -b <branch> <baseCommitish=pin sha>，cwd=主仓', async () => {
  const r = await createWorktree({
    repoDir: '/ws/your-monorepo',
    path: '/ws/your-monorepo-forge-x',
    branch: 'forge/x',
    baseCommitish: 'deadbeefpinsha', // 建树锚点传不可变 sha（非移动 ref，Codex B1）
    addScript: '/ws/your-monorepo/tools/scripts/wt.sh',
  });
  assert.equal(r.ok, true);
  assert.equal(runCalls.length, 1);
  assert.deepEqual(runCalls[0], {
    bin: 'bash',
    args: ['/ws/your-monorepo/tools/scripts/wt.sh', '/ws/your-monorepo-forge-x', '-b', 'forge/x', 'deadbeefpinsha'],
    cwd: '/ws/your-monorepo',
  });
});

test('createWorktree（无脚本回退裸 git）：git -C <repo> worktree add ...', async () => {
  await createWorktree({ repoDir: '/r', path: '/r-forge-x', branch: 'forge/x', baseCommitish: 'deadbeefpinsha' });
  assert.deepEqual(runCalls[0].args, ['-C', '/r', 'worktree', 'add', '/r-forge-x', '-b', 'forge/x', 'deadbeefpinsha']);
  assert.equal(runCalls[0].bin, 'git');
});

test('createWorktree：脚本非零退出 → ok:false（失败不抛，交调用方停泊）', async () => {
  runResult = { code: 1, stdout: '', stderr: 'wt 失败', timedOut: false };
  const r = await createWorktree({ repoDir: '/r', path: '/r-x', branch: 'b', baseCommitish: 'sha' });
  assert.equal(r.ok, false);
  assert.match(r.output, /wt 失败/);
});

test('createWorktree：超时 → ok:false', async () => {
  runResult = { code: 0, stdout: '', stderr: '', timedOut: true };
  const r = await createWorktree({ repoDir: '/r', path: '/r-x', branch: 'b', baseCommitish: 'sha' });
  assert.equal(r.ok, false);
});

test('removeWorktree（无脚本回退）：git worktree remove --force + prune', async () => {
  const r = await removeWorktree({ repoDir: '/r', path: '/r-x' });
  assert.equal(r.ok, true);
  assert.equal(runCalls.length, 2);
  assert.deepEqual(runCalls[0].args, ['-C', '/r', 'worktree', 'remove', '--force', '/r-x']);
  assert.deepEqual(runCalls[1].args, ['-C', '/r', 'worktree', 'prune']);
});

test('removeWorktree（委托脚本）：bash <removeScript> <path>', async () => {
  await removeWorktree({ repoDir: '/r', path: '/r-x', removeScript: '/r/scripts/wt-rm.sh' });
  assert.equal(runCalls.length, 1);
  assert.deepEqual(runCalls[0], { bin: 'bash', args: ['/r/scripts/wt-rm.sh', '/r-x'], cwd: '/r' });
});

test('listWorktrees：解析 porcelain 的 worktree 行；出错降级 []', () => {
  syncOut = 'worktree /ws/your-monorepo\nHEAD abc\nbranch refs/heads/main\n\nworktree /ws/your-monorepo-forge-x\nHEAD def\n';
  assert.deepEqual(listWorktrees('/ws/your-monorepo'), ['/ws/your-monorepo', '/ws/your-monorepo-forge-x']);
  syncThrow = true;
  assert.deepEqual(listWorktrees('/ws/your-monorepo'), []);
});

test('worktreeHeadSha：返回 trim 后的 sha；出错返回 null', () => {
  syncOut = 'deadbeef1234\n';
  assert.equal(worktreeHeadSha('/r-x'), 'deadbeef1234');
  syncThrow = true;
  assert.equal(worktreeHeadSha('/r-x'), null);
});

test('deleteBranch：git -C <repo> branch -D <branch>；删除失败吞掉不抛（分支不存在是常态）', () => {
  deleteBranch('/r', 'forge/x');
  assert.deepEqual(syncCalls.at(-1), ['-C', '/r', 'branch', '-D', 'forge/x']);
  // 孤儿前清场景：分支可能不存在 / 删除失败 → 绝不抛（否则重 setup 直接崩）。
  syncThrow = true;
  assert.doesNotThrow(() => deleteBranch('/r', 'forge/x'));
});

// ── 孤儿 worktree 清扫决策（planWorktreeSweep，纯函数）──
test('planWorktreeSweep：清 SHIPPED 遗留 + 无 owner 的 forge 孤儿；绝不碰在用/太新/非 forge 无主', () => {
  const H = 3600_000;
  const onDisk = [
    { path: '/p/repo-forge-live', ageMs: 5 * H }, // 在用（非终态 session）→ 留
    { path: '/p/repo-forge-shipped', ageMs: 5 * H }, // SHIPPED 遗留 → 清
    { path: '/p/repo-forge-orphan', ageMs: 5 * H }, // 无 owner 的 forge 孤儿 → 清
    { path: '/p/repo-forge-fresh', ageMs: 0.1 * H }, // forge 但太新（可能在建）→ 留
    { path: '/p/user-scratch', ageMs: 9 * H }, // 非 forge、无主 → 留（别误删用户 worktree）
  ];
  const sweep = planWorktreeSweep({
    onDisk,
    shippedPaths: new Set(['/p/repo-forge-shipped']),
    livePaths: new Set(['/p/repo-forge-live']),
    minAgeMs: 1 * H,
  });
  assert.deepEqual(sweep.sort(), ['/p/repo-forge-orphan', '/p/repo-forge-shipped']);
});

test('planWorktreeSweep：在用优先于一切——即便它恰好也在 shippedPaths/太老也不清（绝不毁在用工作树）', () => {
  const sweep = planWorktreeSweep({
    onDisk: [{ path: '/p/repo-forge-x', ageMs: 99 * 3600_000 }],
    shippedPaths: new Set(['/p/repo-forge-x']),
    livePaths: new Set(['/p/repo-forge-x']),
    minAgeMs: 3600_000,
  });
  assert.deepEqual(sweep, []);
});

test('planWorktreeSweep：SHIPPED 遗留但太新 → 仍留（年龄保护窗优先，防撞在建）', () => {
  const sweep = planWorktreeSweep({
    onDisk: [{ path: '/p/repo-forge-x', ageMs: 10_000 }],
    shippedPaths: new Set(['/p/repo-forge-x']),
    livePaths: new Set(),
    minAgeMs: 3600_000,
  });
  assert.deepEqual(sweep, []);
});

test('planWorktreeSweep：新约定 .forge/worktrees/ 路径段也识别为 forge 孤儿（无 owner → 清）', () => {
  const sweep = planWorktreeSweep({
    onDisk: [
      { path: '/p/demo/.forge/worktrees/req-abc', ageMs: 5 * 3600_000 }, // 新约定无主孤儿 → 清
      { path: '/p/example-web/.forge/worktrees/req-live', ageMs: 5 * 3600_000 }, // 在用 → 留
    ],
    shippedPaths: new Set(),
    livePaths: new Set(['/p/example-web/.forge/worktrees/req-live']),
    minAgeMs: 3600_000,
  });
  assert.deepEqual(sweep, ['/p/demo/.forge/worktrees/req-abc']);
});

// ── ensureWorktreeExcluded：把 .forge/ 写进该仓本地 .git/info/exclude（不入库、不动产品仓 .gitignore）──
test('ensureWorktreeExcluded：写 /.forge/ 进主 checkout 的 .git/info/exclude，幂等不重复', () => {
  const repo = mkdtempSync(join(tmpdir(), 'forge-wt-'));
  mkdirSync(join(repo, '.git'));
  ensureWorktreeExcluded(repo);
  const ex = join(repo, '.git', 'info', 'exclude');
  assert.ok(existsSync(ex));
  const first = readFileSync(ex, 'utf8');
  assert.match(first, /^\/\.forge\/$/m); // 有一行精确等于 /.forge/
  ensureWorktreeExcluded(repo); // 再调
  assert.equal(readFileSync(ex, 'utf8'), first); // 幂等：内容不变，绝不重复追加
});

test('ensureWorktreeExcluded：.git 是文件（worktree/gitfile）或缺失 → 跳过、不抛', () => {
  const f = mkdtempSync(join(tmpdir(), 'forge-wt-'));
  writeFileSync(join(f, '.git'), 'gitdir: /elsewhere\n'); // .git 为文件
  ensureWorktreeExcluded(f); // 不抛
  assert.ok(!existsSync(join(f, '.git', 'info', 'exclude')));
  const none = mkdtempSync(join(tmpdir(), 'forge-wt-')); // 无 .git
  ensureWorktreeExcluded(none); // 不抛
});
