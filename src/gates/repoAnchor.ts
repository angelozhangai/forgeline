// Review anchoring check: the `origin/<branch>` sha obtained by fetch (see repoFreshness) is only the
// **remote truth**, but when claude runs a review or produces a design with `cwd = the project root` it
// reads the **live checkout**. If that checkout is not on that sha (wrong branch, behind) or has
// uncommitted changes, the conclusions are drawn against unanchored, unshipped code — the most dangerous
// kind of false review finding. This module finds that and handles it (disclose it to the model, or park
// strictly).
//
// Deliberately in a separate file from repoFreshness (fetch): drift.test mocks repoFreshness wholesale, and
// keeping the anchoring check here lets that test retain the **real** reposOffRef (drift's reconciliation
// correctness depends on it); Gate B's production-path test can simply mock this module on its own.
import { runSync } from '../util/proc.ts';
import type { RepoShas } from '../types.ts';
import type { ProjectFull } from '../projects.ts';
import type { Freshness } from './repoFreshness.ts';

// Whether each repo's local checkout is aligned with the given sha: HEAD != sha, or a dirty working tree,
// means unaligned. If HEAD or the status cannot be determined, treat it as unaligned (untrustworthy, so do
// not press ahead).
export function reposOffRef(proj: Pick<ProjectFull, 'repoPath'>, shas: RepoShas): string[] {
  const off: string[] = [];
  for (const [repo, sha] of Object.entries(shas)) {
    const dir = proj.repoPath(repo);
    try {
      const head = runSync('git', ['-C', dir, 'rev-parse', 'HEAD']).trim();
      const dirty = runSync('git', ['-C', dir, 'status', '--porcelain']).trim().length > 0;
      if (head !== sha || dirty) off.push(repo);
    } catch {
      off.push(repo);
    }
  }
  return off;
}

export type AnchorMode = 'warn' | 'block';

// The checkout anchoring check run before a gate reviews or produces a design.
// - All aligned -> empty disclosure, proceed as normal.
// - Some off + mode=block -> throw (the caller parks; never draw conclusions against unanchored code).
// - Some off + mode=warn -> return the **disclosure text** (injected into the prompt's freshness block,
//   honestly telling the model "these repos' checkouts are not on the anchored sha; read the code as of
//   origin/<branch>"). Failure is never silent: better to tell the model than to pretend it is anchored.
export function anchorCheck(
  proj: Pick<ProjectFull, 'repoPath'>,
  fresh: Pick<Freshness, 'branch' | 'shas'>,
  mode: AnchorMode,
): { off: string[]; disclosure: string } {
  const off = reposOffRef(proj, fresh.shas);
  if (!off.length) return { off, disclosure: '' };
  if (mode === 'block') {
    throw new Error(`Code checkout is not anchored to origin/${fresh.branch}: ${off.join(', ')} (HEAD differs from that sha, or there are uncommitted changes) — pausing, to avoid drawing conclusions against unanchored code`);
  }
  const disclosure =
    `\n\n⚠️ **Checkout not anchored**: the local checkout of ${off.join(', ')} is not on \`origin/${fresh.branch}\` (HEAD differs, or there are uncommitted changes). ` +
    `When reading code in those repos, treat \`git show origin/${fresh.branch}:<path>\` as authoritative, and **do not take unshipped or local changes as existing fact**.`;
  return { off, disclosure };
}
