// 单测：repoFreshness 的 fetch 退避重试 + assertFresh 守卫（取不到代码真源 → 抛，绝不静默降级评审）。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// fetch 调用的逐次结果计划（'ok' | 'fail'），以及调用计数（按 repo 重置）。
let fetchPlan: ('ok' | 'fail')[] = [];
let fetchCalls = 0;

mock.module('../src/util/log.ts', {
  namedExports: { log: { info: () => {}, ok: () => {}, warn: () => {}, err: () => {} } },
});
// refresh 改用异步 run（非 runSync），返回 RunResult；fetch 失败用 code≠0 表达（run 不抛、靠 code 判定）。
mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (_bin: string, args: string[]) => {
      if (args.includes('fetch')) {
        const outcome = fetchPlan[fetchCalls] ?? 'ok';
        fetchCalls++;
        if (outcome === 'fail') return { code: 1, stdout: '', stderr: 'network blip', timedOut: false };
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      }
      if (args.includes('rev-parse')) return { code: 0, stdout: 'deadbeefcafe0000\n', stderr: '', timedOut: false };
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    },
  },
});

const { refresh, anyFetchFailed, failedRepos, assertFresh } = await import('../src/gates/repoFreshness.ts');

// 目标项目桩：refresh 按 session 的项目取 repos + repoPath（多项目改造后）。
const proj = { repos: ['repoX'], repoPath: (r: string) => `/tmp/${r}` };

function reset(plan: ('ok' | 'fail')[]): void {
  fetchPlan = plan;
  fetchCalls = 0;
}

test('refresh：首次成功 → 一次 fetch + sha 解析，无 ERROR', async () => {
  reset(['ok']);
  const f = await refresh('main', proj);
  assert.equal(fetchCalls, 1);
  assert.equal(f.shas.repoX, 'deadbeefcafe0000');
  assert.equal(anyFetchFailed(f), false);
  assert.doesNotThrow(() => assertFresh(f));
});

test('refresh：首次失败、第二次成功 → 退避后重试拿到 sha（不记 ERROR）', async () => {
  reset(['fail', 'ok']);
  const f = await refresh('main', proj);
  assert.equal(fetchCalls, 2);
  assert.equal(f.shas.repoX, 'deadbeefcafe0000');
  assert.equal(anyFetchFailed(f), false);
});

test('refresh：三次全失败 → 记 ERROR，anyFetchFailed/failedRepos 命中，assertFresh 抛', async () => {
  reset(['fail', 'fail', 'fail']);
  const f = await refresh('main', proj);
  assert.equal(fetchCalls, 3); // FETCH_ATTEMPTS=3，耗尽
  assert.equal(f.shas.repoX, 'ERROR');
  assert.equal(anyFetchFailed(f), true);
  assert.deepEqual(failedRepos(f), ['repoX']);
  assert.throws(() => assertFresh(f), /fetch 失败/);
});
