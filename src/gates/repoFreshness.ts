import { run } from '../util/proc.ts';
import { log } from '../util/log.ts';
import type { RepoShas } from '../types.ts';
import type { ProjectFull } from '../projects.ts';

export interface Freshness {
  branch: string;
  fetchedAt: string;
  shas: RepoShas;
  refsText: string; // 给 prompt 的 repo-freshness 片段
}

// 单仓 fetch 的瞬时失败重试：网络抖动 / .git 锁竞争常一次即恢复，退避重试避免把瞬时抖动误判成"取不到代码真源"。
const FETCH_ATTEMPTS = 3;
const FETCH_BACKOFF_MS = [400, 1200]; // 第 1 次失败后等 400ms，第 2 次后 1200ms（最后一次失败不再等）

// 异步退避：git 走 await run（异步、不阻塞 daemon event loop），sleep 用 setTimeout——
// 区别于旧实现的 runSync + Atomics.wait（同步阻塞整个进程，三仓串行更糟）。
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// fetch + rev-parse 单仓，失败退避重试，耗尽抛出最后一次错（交 refresh 记 ERROR）。
// run 不像 runSync 在非零退出时抛错，故显式判 code（含 ENOENT/spawn 失败时的 code=null）。
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

// fetch 三仓的指定分支并解析 sha。每次闸分析前调用（本地 ref 会过期）。三仓 fetch 互相独立 → Promise.all 并行
// （网络往返不再串行、不阻塞 event loop）。单仓失败记 ERROR 不中断其余仓——是否因此停泊评审由调用方 assertFresh
// 决定（绝不静默对着取不到的代码真源评审）。proj：目标项目（按 session 解析）——决定 fetch 哪些子仓、各仓在哪。
export async function refresh(branch: string, proj: Pick<ProjectFull, 'repos' | 'repoPath'>): Promise<Freshness> {
  // Promise.all 保序 → shas/refsText 仍按 proj.repos 顺序，prompt 片段确定可复现。
  const results = await Promise.all(
    proj.repos.map(async (repo) => {
      const dir = proj.repoPath(repo);
      try {
        const sha = await fetchOne(dir, branch);
        return { repo, sha, line: `- ${repo}: \`origin/${branch}\` @ \`${sha.slice(0, 12)}\`` };
      } catch (e) {
        log.warn(`仓 ${repo} fetch origin/${branch} 重试 ${FETCH_ATTEMPTS} 次仍失败`);
        return { repo, sha: 'ERROR', line: `- ${repo}: ⚠ fetch 失败（重试 ${FETCH_ATTEMPTS} 次仍失败：${String(e).slice(0, 100)}）` };
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

// fetch 失败的仓名（ERROR 标记）。
export function failedRepos(f: Freshness): string[] {
  return Object.entries(f.shas).filter(([, sha]) => sha === 'ERROR').map(([r]) => r);
}

// 任一仓取不到代码真源 → 抛出（绝不静默对着 ERROR / 陈旧 sha 评审）。
// 错误信息含「fetch 失败」关键词，便于上层把它归类为**瞬时错**走自动退避重试，而非永久停泊。
export function assertFresh(f: Freshness): void {
  const failed = failedRepos(f);
  if (failed.length) {
    throw new Error(`代码真源 git fetch 失败：${failed.join(', ')}（已重试仍失败）— 暂停评审，待重试拉取`);
  }
}
