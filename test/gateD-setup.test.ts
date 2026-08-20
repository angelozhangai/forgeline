// 集成：openReviewPr 委托建 PR 的关键不变量——
//  · 委托 proj.scripts.create_pr（cwd=worktree，--base=session.branch），绝不在 forge 重造 gh。
//  · 从脚本 stdout 末行解析 PR URL + 编号落库；末行非 URL / 脚本失败 → 抛（worker 停泊 GATE_D_FAILED，不静默落空）。
// mock proc.run / projects / gateC 信封；真 sessions(:memory:)。不起真 gh/git。
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

interface RunCall { bin: string; args: string[]; cwd?: string }
type RunRes = { code: number; stdout: string; stderr: string; timedOut: boolean };
let runCalls: RunCall[] = [];
let runResult: RunRes = { code: 0, stdout: '', stderr: '', timedOut: false };
let runQueue: RunRes[] = []; // 多 PR：每次 run 取队首（空则回退 runResult），便于每仓返回各自 PR URL

mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (bin: string, args: string[], opts: { cwd?: string } = {}) => {
      runCalls.push({ bin, args, cwd: opts.cwd });
      return runQueue.length ? (runQueue.shift() as RunRes) : runResult;
    },
    runSync: () => '',
  },
});
const env = {
  worktree_path: '/wt', impl_branch: 'forge/x', base_ref: 'origin/main', base_sha: 'PINSHA',
  implemented: true, diff_stat: ' a.ts | 2 +-', files_changed: ['a.ts'], ci_ok: true, ci_summary: '', last_summary: '',
};
mock.module('../src/gates/gateC.ts', {
  namedExports: { readImplEnvelope: () => env, gateCContext: () => '技术方案：做 X' },
});
mock.module('../src/projects.ts', {
  namedExports: {
    projectForSession: () => ({
      id: 'p', root: '/proj', repos: ['.'], repoPath: () => '/proj/repo',
      scripts: { create_pr: './tools/scripts/forge-create-pr.sh', ci: './tools/scripts/forge-ci.sh', worktree_add: './tools/scripts/wt.sh' },
    }),
  },
});

const sessions = await import('../src/store/sessions.ts');
const gateD = await import('../src/gates/gateD.ts');
const { mkLeg } = await import('../src/gates/legs.ts');

let n = 0;
async function mk(): Promise<string> {
  const id = `pr${++n}`;
  await sessions.create({ id, slug: id, title: '修登录态丢失', branch: 'main' });
  return id;
}

beforeEach(() => {
  runCalls = [];
  runResult = { code: 0, stdout: '', stderr: '', timedOut: false };
  runQueue = [];
});

test('openReviewPr：委托 forge-create-pr.sh（cwd=worktree, --base=branch）+ 解析末行 PR URL 落库', async () => {
  runResult = { code: 0, stdout: '推分支…\nhttps://github.com/your-org/x/pull/42\n', stderr: '', timedOut: false };
  const id = await mk();
  await gateD.openReviewPr((await sessions.get(id))!);
  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].bin, 'bash');
  assert.equal(runCalls[0].cwd, '/wt');
  assert.equal(runCalls[0].args[0], '/wt/tools/scripts/forge-create-pr.sh'); // 相对 worktree 解析
  assert.ok(runCalls[0].args.includes('--base'));
  assert.equal(runCalls[0].args[runCalls[0].args.indexOf('--base') + 1], 'main');
  const s = (await sessions.get(id))!;
  assert.equal(s.pr_url, 'https://github.com/your-org/x/pull/42');
  assert.equal(s.pr_number, 42);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gated_pr_opened'));
});

test('openReviewPr：脚本非零退出 → 抛（worker 停泊 GATE_D_FAILED）', async () => {
  runResult = { code: 1, stdout: '', stderr: 'gh auth required', timedOut: false };
  await assert.rejects(async () => gateD.openReviewPr((await sessions.get(await mk()))!), /开 PR 失败/);
});

test('openReviewPr：退 0 但末行非 URL → 抛（不静默落空 pr_url）', async () => {
  runResult = { code: 0, stdout: '建好了但忘了打印 url', stderr: '', timedOut: false };
  const id = await mk();
  await assert.rejects(async () => gateD.openReviewPr((await sessions.get(id))!), /未在末行输出 PR URL/);
  assert.equal((await sessions.get(id))!.pr_url, null); // 没落空值
});

test('openReviewPr：已有 pr_url（崩在 patch 后/transition 前的重入）→ 不再调脚本（SF1：本地已有 URL 别重复外向写）', async () => {
  const id = await mk();
  await sessions.patch(id, { pr_url: 'https://github.com/your-org/x/pull/7', pr_number: 7 });
  await gateD.openReviewPr((await sessions.get(id))!);
  assert.equal(runCalls.length, 0); // 早返回，绝不重复调 create_pr
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gated_pr_reused'));
});

// ── Phase 2b：多仓「每仓一树一PR」——openReviewPr 对每条已建树 leg 各开一个 PR，URL 落各自 leg ──
test('openReviewPr（多仓/2b）：每条 leg 各开一 PR，URL 落各自 leg；session.pr_url=primary（向后兼容）', async () => {
  const id = await mk();
  await sessions.patch(id, {
    legs: JSON.stringify([
      mkLeg('demo', { worktree_path: '/wt/demo', impl_branch: 'forge/k', base_sha: 'C' }),
      mkLeg('example-web', { worktree_path: '/wt/example', impl_branch: 'forge/k', base_sha: 'U' }),
    ]),
  });
  runQueue = [
    { code: 0, stdout: 'push…\nhttps://github.com/your-org/demo/pull/11\n', stderr: '', timedOut: false },
    { code: 0, stdout: 'push…\nhttps://github.com/your-org/example-web/pull/22\n', stderr: '', timedOut: false },
  ];
  await gateD.openReviewPr((await sessions.get(id))!);
  assert.equal(runCalls.length, 2); // 每仓一次建 PR
  assert.equal(runCalls[0].cwd, '/wt/demo'); // 各自 worktree 为 cwd
  assert.equal(runCalls[1].cwd, '/wt/example');
  const legs = JSON.parse((await sessions.get(id))!.legs!);
  assert.equal(legs[0].pr_url, 'https://github.com/your-org/demo/pull/11');
  assert.equal(legs[0].pr_number, 11);
  assert.equal(legs[1].pr_url, 'https://github.com/your-org/example-web/pull/22');
  assert.equal(legs[1].pr_number, 22);
  assert.equal((await sessions.get(id))!.pr_url, 'https://github.com/your-org/demo/pull/11'); // primary 向后兼容
});

test('openReviewPr（多仓/2b）：幂等——已开 PR 的 leg 跳过、只补未开的（崩溃重入安全）', async () => {
  const id = await mk();
  await sessions.patch(id, {
    legs: JSON.stringify([
      mkLeg('demo', { worktree_path: '/wt/demo', base_sha: 'C', pr_url: 'https://github.com/your-org/demo/pull/11', pr_number: 11 }),
      mkLeg('example-web', { worktree_path: '/wt/example', base_sha: 'U' }),
    ]),
  });
  runQueue = [{ code: 0, stdout: 'https://github.com/your-org/example-web/pull/22\n', stderr: '', timedOut: false }];
  await gateD.openReviewPr((await sessions.get(id))!);
  assert.equal(runCalls.length, 1); // 只为未开 PR 的 example-web 调一次
  assert.equal(runCalls[0].cwd, '/wt/example');
  const legs = JSON.parse((await sessions.get(id))!.legs!);
  assert.equal(legs[1].pr_url, 'https://github.com/your-org/example-web/pull/22');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gated_pr_reused')); // demo leg 复用
});
