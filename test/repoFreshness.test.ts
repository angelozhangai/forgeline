// Unit tests: repoFreshness's fetch backoff retries plus the assertFresh guard (the source of truth in the
// code cannot be fetched -> throw, never silently degrade the review).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// The planned outcome of each successive fetch call ('ok' | 'fail'), plus the call count (reset per repo).
let fetchPlan: ('ok' | 'fail')[] = [];
let fetchCalls = 0;

mock.module('../src/util/log.ts', {
  namedExports: { log: { info: () => {}, ok: () => {}, warn: () => {}, err: () => {} } },
});
// refresh uses the asynchronous `run` (not runSync) and gets a RunResult back; a failed fetch is expressed
// as a non-zero code (run does not throw, so the code is what decides).
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

// Target-project stub: refresh takes repos and repoPath from the session's project (after the multi-project
// change).
const proj = { repos: ['repoX'], repoPath: (r: string) => `/tmp/${r}` };

function reset(plan: ('ok' | 'fail')[]): void {
  fetchPlan = plan;
  fetchCalls = 0;
}

test('refresh: succeeds first time -> one fetch plus the sha resolution, with no ERROR', async () => {
  reset(['ok']);
  const f = await refresh('main', proj);
  assert.equal(fetchCalls, 1);
  assert.equal(f.shas.repoX, 'deadbeefcafe0000');
  assert.equal(anyFetchFailed(f), false);
  assert.doesNotThrow(() => assertFresh(f));
});

test('refresh: fails once then succeeds -> the retry after the backoff gets the sha (no ERROR recorded)', async () => {
  reset(['fail', 'ok']);
  const f = await refresh('main', proj);
  assert.equal(fetchCalls, 2);
  assert.equal(f.shas.repoX, 'deadbeefcafe0000');
  assert.equal(anyFetchFailed(f), false);
});

test('refresh: all three attempts fail -> ERROR is recorded, anyFetchFailed/failedRepos catch it, and assertFresh throws', async () => {
  reset(['fail', 'fail', 'fail']);
  const f = await refresh('main', proj);
  assert.equal(fetchCalls, 3); // FETCH_ATTEMPTS=3, exhausted
  assert.equal(f.shas.repoX, 'ERROR');
  assert.equal(anyFetchFailed(f), true);
  assert.deepEqual(failedRepos(f), ['repoX']);
  // The wording matters: "fetch failed" is what orchestrator/retry.ts matches to classify this as transient
  // and schedule a backoff retry, rather than parking the session permanently.
  assert.throws(() => assertFresh(f), /fetch failed/);
});
