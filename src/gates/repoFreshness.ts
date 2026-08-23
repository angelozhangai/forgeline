import { run } from '../util/proc.ts';
import { log } from '../util/log.ts';
import type { RepoShas } from '../types.ts';
import type { ProjectFull } from '../projects.ts';

export interface Freshness {
  branch: string;
  fetchedAt: string;
  shas: RepoShas;
  refsText: string; // the repo-freshness fragment handed to the prompt
}

// Retry a single repo's fetch on a transient failure: network flakiness and .git lock contention usually
// recover on the next attempt, so backing off keeps a momentary blip from being misjudged as "the source of
// truth in the code is unavailable".
const FETCH_ATTEMPTS = 3;
const FETCH_BACKOFF_MS = [400, 1200]; // wait 400ms after the first failure and 1200ms after the second (no wait after the last)

// Asynchronous backoff: git goes through `await run` (asynchronous, not blocking the daemon's event loop)
// and the sleep uses setTimeout — unlike the old runSync + Atomics.wait implementation, which blocked the
// whole process synchronously and was even worse across three sequential repos.
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// fetch + rev-parse for one repo, backing off and retrying on failure and throwing the last error once
// exhausted (refresh records it as ERROR).
// Unlike runSync, `run` does not throw on a non-zero exit, so the code is checked explicitly (including
// code=null for ENOENT and spawn failures).
async function fetchOne(dir: string, branch: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(FETCH_BACKOFF_MS[Math.min(attempt - 1, FETCH_BACKOFF_MS.length - 1)]);
    try {
      const fetched = await run('git', ['-C', dir, 'fetch', 'origin', branch, '--quiet']);
      if (fetched.code !== 0) throw new Error(`git fetch exited ${fetched.code}: ${(fetched.stderr || '').slice(0, 500)}`);
      const parsed = await run('git', ['-C', dir, 'rev-parse', `origin/${branch}`]);
      if (parsed.code !== 0) throw new Error(`git rev-parse exited ${parsed.code}: ${(parsed.stderr || '').slice(0, 500)}`);
      return parsed.stdout.trim();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Fetch the given branch in all repos and resolve their shas. Called before every gate analysis (local refs
// go stale). The fetches are independent of each other -> Promise.all runs them in parallel (so the network
// round trips are no longer sequential and do not block the event loop).
// A single repo's failure is recorded as ERROR without interrupting the others — whether that parks the
// review is decided by the caller's assertFresh (never silently review against a source of truth that could
// not be fetched). `proj` is the target project (resolved per session) and decides which sub-repos to fetch
// and where each one lives.
export async function refresh(branch: string, proj: Pick<ProjectFull, 'repos' | 'repoPath'>): Promise<Freshness> {
  // Promise.all preserves order -> shas/refsText stay in proj.repos order, so the prompt fragment is
  // deterministic and reproducible.
  const results = await Promise.all(
    proj.repos.map(async (repo) => {
      const dir = proj.repoPath(repo);
      try {
        const sha = await fetchOne(dir, branch);
        return { repo, sha, line: `- ${repo}: \`origin/${branch}\` @ \`${sha.slice(0, 12)}\`` };
      } catch (e) {
        log.warn(`Repo ${repo}: fetch origin/${branch} still failed after ${FETCH_ATTEMPTS} attempts`);
        return { repo, sha: 'ERROR', line: `- ${repo}: ⚠ fetch failed (still failing after ${FETCH_ATTEMPTS} attempts: ${String(e).slice(0, 100)})` };
      }
    }),
  );
  const shas: RepoShas = {};
  const lines: string[] = [];
  for (const r of results) {
    shas[r.repo] = r.sha;
    lines.push(r.line);
  }
  return {
    branch,
    fetchedAt: new Date().toISOString(),
    shas,
    refsText: lines.join('\n'),
  };
}

export function anyFetchFailed(f: Freshness): boolean {
  return Object.values(f.shas).some((s) => s === 'ERROR');
}

// The names of the repos whose fetch failed (marked ERROR).
export function failedRepos(f: Freshness): string[] {
  return Object.entries(f.shas).filter(([, sha]) => sha === 'ERROR').map(([r]) => r);
}

// Any repo whose source of truth could not be fetched -> throw (never silently review against an ERROR or a
// stale sha).
// The message deliberately contains the phrase "fetch failed", which is what lets the layer above classify
// it as a **transient** error and put it through automatic backoff retries rather than parking it
// permanently (see TRANSIENT in orchestrator/retry.ts).
export function assertFresh(f: Freshness): void {
  const failed = failedRepos(f);
  if (failed.length) {
    throw new Error(`git fetch failed for the source of truth: ${failed.join(', ')} (still failing after retries) — pausing the review until the fetch is retried`);
  }
}
