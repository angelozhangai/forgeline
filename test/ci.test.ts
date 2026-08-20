// 单测：ci.ts 的确定性 CI 闸 + worktree git 助手。mock proc 断言：CI ran/ok 语义、未配脚本即 park、
// 无改动不空提交、降级路径不抛。不起真 CI/git 进程。
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let runResult = { code: 0, stdout: '', stderr: '', timedOut: false };
let runCalls: { bin: string; args: string[]; cwd?: string }[] = [];
let syncBy: (args: string[]) => string = () => '';

mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (bin: string, args: string[], opts: { cwd?: string } = {}) => {
      runCalls.push({ bin, args, cwd: opts.cwd });
      return runResult;
    },
    runSync: (_bin: string, args: string[]) => syncBy(args),
  },
});

const { runCi, hasCommitsSince, diffStatSince, changedFilesSince, commitWorktree, worktreeClean, resetWorktree } = await import('../src/gates/ci.ts');

beforeEach(() => {
  runResult = { code: 0, stdout: 'all green', stderr: '', timedOut: false };
  runCalls = [];
  syncBy = () => '';
});

test('runCi：未配 scripts.ci → ran:false（绝不裸 nx，交人工 park）', async () => {
  const r = await runCi('/wt', undefined);
  assert.equal(r.ran, false);
  assert.equal(r.ok, false);
  assert.match(r.summary, /未配置 scripts.ci/);
  assert.equal(runCalls.length, 0);
});

test('runCi：脚本退 0 → ok:true ran:true，cwd=worktree，bash <script> affected --base', async () => {
  const r = await runCi('/wt', '/wt/tools/scripts/forge-ci.sh', { base: 'origin/main' });
  assert.equal(r.ok, true);
  assert.equal(r.ran, true);
  assert.equal(runCalls[0].cwd, '/wt');
  assert.deepEqual(runCalls[0].args, ['/wt/tools/scripts/forge-ci.sh', 'affected', '--base', 'origin/main']);
});

test('runCi：脚本退非 0（测试失败）→ ran:true ok:false（红，喂 claude 续修，不 park）', async () => {
  runResult = { code: 1, stdout: 'FAIL libs/x', stderr: '', timedOut: false };
  const r = await runCi('/wt', '/wt/forge-ci.sh');
  assert.equal(r.ran, true);
  assert.equal(r.ok, false);
  assert.match(r.summary, /FAIL libs\/x/);
});

test('runCi：spawn 失败（code=null）/ 超时 → ran:false（基础设施错，park）', async () => {
  runResult = { code: null, stdout: '', stderr: 'ENOENT', timedOut: false };
  assert.equal((await runCi('/wt', '/wt/forge-ci.sh')).ran, false);
  runResult = { code: 0, stdout: '', stderr: '', timedOut: true };
  assert.equal((await runCi('/wt', '/wt/forge-ci.sh')).ran, false);
});

test('hasCommitsSince：rev-list count 非 0 → true；0 → false', () => {
  syncBy = () => '2\n';
  assert.equal(hasCommitsSince('/wt', 'base'), true);
  syncBy = () => '0\n';
  assert.equal(hasCommitsSince('/wt', 'base'), false);
});

test('changedFilesSince：解析 name-only 行；出错降级 []', () => {
  syncBy = () => 'libs/a.ts\napps/b.ts\n';
  assert.deepEqual(changedFilesSince('/wt', 'base'), ['libs/a.ts', 'apps/b.ts']);
  syncBy = () => { throw new Error('git boom'); };
  assert.deepEqual(changedFilesSince('/wt', 'base'), []);
  assert.equal(diffStatSince('/wt', 'base'), '');
});

test('commitWorktree：有改动 → add -A + commit（forge author + --no-verify）→ ok:true committed:true', () => {
  const seen: string[][] = [];
  syncBy = (args) => {
    seen.push(args);
    if (args.includes('status')) return ' M libs/a.ts\n'; // 有改动
    return 'committed';
  };
  const r = commitWorktree('/wt', 'forge(闸C x): round 1');
  assert.equal(r.ok, true);
  assert.equal(r.committed, true);
  const commitArgs = seen.find((a) => a.includes('commit'))!;
  assert.ok(commitArgs.includes('--no-verify'));
  assert.ok(commitArgs.includes('user.email=forge@local'));
});

test('commitWorktree：无改动 → ok:true committed:false（不空提交，但成功——区别于失败）', () => {
  syncBy = (args) => (args.includes('status') ? '' : 'x'); // 干净工作树
  const r = commitWorktree('/wt', 'm');
  assert.equal(r.ok, true);
  assert.equal(r.committed, false);
});

test('commitWorktree：commit 抛错 → ok:false（提交失败≠无改动；调用方据此停泊，绝不带脏树跑 CI/推）', () => {
  syncBy = (args) => {
    if (args.includes('status')) return ' M libs/a.ts\n'; // 有改动
    if (args.includes('commit')) throw new Error('commit boom'); // 提交炸了（add -A 已把改动留在 index）
    return '';
  };
  const r = commitWorktree('/wt', 'm');
  assert.equal(r.ok, false);
  assert.equal(r.committed, false);
});

test('worktreeClean：porcelain 空 → true；非空 → false；出错 → false（保守判脏逼停泊）', () => {
  syncBy = () => '';
  assert.equal(worktreeClean('/wt'), true);
  syncBy = () => ' M a.ts\n';
  assert.equal(worktreeClean('/wt'), false);
  syncBy = () => { throw new Error('git boom'); };
  assert.equal(worktreeClean('/wt'), false);
});

test('resetWorktree：reset --hard <sha> + clean -fd + 复位后再验 porcelain；全 0 且干净 → ok:true', () => {
  const seen: string[][] = [];
  syncBy = (args) => { seen.push(args); return ''; };
  const r = resetWorktree('/wt', 'PREHEAD');
  assert.equal(r.ok, true);
  assert.deepEqual(seen[0], ['-C', '/wt', 'reset', '--hard', 'PREHEAD']);
  assert.deepEqual(seen[1], ['-C', '/wt', 'clean', '-fd']);
  assert.deepEqual(seen[2], ['-C', '/wt', 'status', '--porcelain']); // 复位后再验一次（Codex SF）
  syncBy = () => { throw new Error('reset boom'); };
  assert.equal(resetWorktree('/wt', 'PREHEAD').ok, false);
});

test('resetWorktree：reset/clean 退 0 但复位后 status 仍非 clean（嵌套 repo/submodule 残留）→ ok:false（不假装复位成功）', () => {
  syncBy = (args) => (args.includes('status') ? ' M sub/x\n' : ''); // reset/clean 退 0、status 仍脏
  const r = resetWorktree('/wt', 'PREHEAD');
  assert.equal(r.ok, false);
  assert.match(r.output, /仍非 clean/);
});
