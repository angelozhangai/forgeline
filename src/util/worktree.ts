// The delegated git-worktree lifecycle: create, clean up and list the **isolated worktrees** for the
// downstream Gate C and Gate D.
// Design discipline (in line with the top rule "mechanical actions call the target project's scripts rather
// than being rebuilt here"):
//  · Creation prefers the target project's worktree_add script (your-monorepo must go through
//    tools/scripts/wt.sh — it also syncs node_modules / .envrc / secrets, without which a bare
//    `git worktree add` produces a tree that cannot run); a bare git call is the fallback only when the
//    project configures no script.
//  · Cleanup goes through the worktree_remove script, or a bare `git worktree remove --force` + `prune`
//    (removal is not covered by your-monorepo's ban, which is on a bare add).
//  · The main checkout stays anchored to origin/<branch> by repoAnchor (a read-only source of truth); the
//    worktree is the isolated place where code, CI and the PR happen. The two never interfere.
import { resolve, basename } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { run, runSync } from './proc.ts';

// Pick the interpreter from the extension (the same convention as workspace.ts): .sh -> bash, .js/.mjs ->
// node, anything else -> executed directly (and must carry the executable bit).
export function interp(script: string, args: string[]): [string, string[]] {
  if (script.endsWith('.sh')) return ['bash', [script, ...args]];
  if (script.endsWith('.js') || script.endsWith('.mjs')) return ['node', [script, ...args]];
  return [script, args];
}

// Truncate output (what reaches the database and the logs stays bounded, never floods them).
function tail(s: string, n = 4000): string {
  const t = s.trim();
  return t.length > n ? t.slice(-n) : t;
}

// The top rule (see "an isolated worktree belongs to the repo it changes" in CLAUDE.md): an isolated worktree
// lands in **that repo's own hidden directory**, <repoDir>/.forge/worktrees/<key>, and never in the umbrella
// repo or a sibling directory. .forge/ is written into that repo's .git/info/exclude by
// ensureWorktreeExcluded — local to this machine, never committed.
// Orphans are recognised by the path segment `/.forge/worktrees/` (see planWorktreeSweep). The key is
// uniquely derived from session.id by gateC.implIdentity.
export const WORKTREE_DIR_SEGMENT = `${'/'}.forge/worktrees/`; // the anchor for orphan detection and exclusion (a variable, to avoid the literal being scattered around)
export function worktreeRoot(repoDir: string): string {
  return resolve(repoDir, '.forge', 'worktrees');
}
export function defaultWorktreePath(repoDir: string, key: string): string {
  return resolve(worktreeRoot(repoDir), key);
}

// Write forge's isolated-worktree root `.forge/` into that repo's **local** .git/info/exclude, so the product
// repo does not track it — and **without touching** the product repo's tracked .gitignore (the top rule:
// Forge leaves no stray changes or commits in a product repo). .git/info/exclude lives in the git common dir
// and is shared by all of that repo's worktrees, so writing it once in the main checkout covers every one.
// Idempotent: if the pattern is already there, it does nothing.
// Best-effort: a failed write is not fatal (the worktree can still be created; the main repo's git status
// just picks up some untracked noise), so the exception is swallowed rather than thrown.
export function ensureWorktreeExcluded(repoDir: string): void {
  try {
    const gitPath = resolve(repoDir, '.git');
    if (!existsSync(gitPath) || !statSync(gitPath).isDirectory()) return; // the main checkout only (.git is a directory); a worktree or a bare repo is skipped
    const infoDir = resolve(gitPath, 'info');
    const excludePath = resolve(infoDir, 'exclude');
    const pattern = '/.forge/';
    const cur = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    if (cur.split('\n').some((l) => l.trim() === pattern)) return; // already excluded
    mkdirSync(infoDir, { recursive: true });
    const sep = cur === '' || cur.endsWith('\n') ? '' : '\n';
    appendFileSync(excludePath, `${sep}# forge isolated worktrees (local; do not commit or push)\n${pattern}\n`);
  } catch {
    /* a failed write to exclude is not fatal: see above */
  }
}

export interface CreateWorktreeOpts {
  repoDir: string; // the main checkout's directory (what git worktree mounts from)
  path: string; // the absolute path of the target worktree
  branch: string; // the new branch name, e.g. forge/<id>
  baseCommitish: string; // the anchor the tree is created from — this **must be an immutable sha**, not a moving ref
  // like origin/main: when a concurrent or external fetch advances origin/<branch>, creating the tree from a
  // moving ref drifts the worktree's baseline away from the recorded base_sha and counts new upstream commits
  // as the implementation (Codex B1).
  addScript?: string; // an absolute path: proj.scripts.worktree_add (falling back to a bare git worktree add)
  timeoutMs?: number; // defaults to 10 minutes (wt.sh includes a pnpm install, so give it room)
}

export interface WorktreeResult {
  ok: boolean;
  path: string;
  branch: string;
  output: string; // truncated stdout+stderr (for diagnosing a failure, and as a record of a success)
}

// Create the isolated worktree. Both the delegated script and the bare git call take the same arguments as
// `git worktree add <path> [-b <branch>] [<commit-ish>]`.
// It does not throw on failure — it returns ok:false plus the output and leaves the caller (gateC) to decide
// whether to park or retry (transient versus permanent is classified by orchestrator/retry).
export async function createWorktree(o: CreateWorktreeOpts): Promise<WorktreeResult> {
  const timeoutMs = o.timeoutMs ?? 600_000;
  const [bin, args] = o.addScript
    ? interp(o.addScript, [o.path, '-b', o.branch, o.baseCommitish])
    : ['git', ['-C', o.repoDir, 'worktree', 'add', o.path, '-b', o.branch, o.baseCommitish]];
  const r = await run(bin, args, { cwd: o.repoDir, timeoutMs });
  return { ok: r.code === 0 && !r.timedOut, path: o.path, branch: o.branch, output: tail(r.stdout + r.stderr) };
}

export interface RemoveWorktreeOpts {
  repoDir: string;
  path: string;
  removeScript?: string; // an absolute path: proj.scripts.worktree_remove (falling back to bare git)
  timeoutMs?: number;
}

// Clean up an isolated worktree (after a terminal state or a failure). The bare fallback: remove --force
// (discarding uncommitted changes) plus prune (clearing the leftover registration).
// Best-effort: it returns ok for the audit trail, but the caller usually does not park a session just because
// cleanup failed (a leftover worktree is caught later by the orphan sweep).
export async function removeWorktree(o: RemoveWorktreeOpts): Promise<{ ok: boolean; output: string }> {
  const timeoutMs = o.timeoutMs ?? 120_000;
  if (o.removeScript) {
    const [bin, args] = interp(o.removeScript, [o.path]);
    const r = await run(bin, args, { cwd: o.repoDir, timeoutMs });
    return { ok: r.code === 0 && !r.timedOut, output: tail(r.stdout + r.stderr) };
  }
  const rm = await run('git', ['-C', o.repoDir, 'worktree', 'remove', '--force', o.path], { cwd: o.repoDir, timeoutMs });
  await run('git', ['-C', o.repoDir, 'worktree', 'prune'], { cwd: o.repoDir, timeoutMs });
  return { ok: rm.code === 0 && !rm.timedOut, output: tail(rm.stdout + rm.stderr) };
}

// List the absolute paths of every worktree under the main checkout (used by the orphan sweep). Best-effort:
// on failure it returns [] — it neither throws nor guesses.
export function listWorktrees(repoDir: string): string[] {
  try {
    const out = runSync('git', ['-C', repoDir, 'worktree', 'list', '--porcelain']);
    return out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// The worktree's current HEAD sha (for recording base_shas and checking the pin). Returns null on failure
// rather than throwing.
export function worktreeHeadSha(worktreePath: string): string | null {
  try {
    return runSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD']).trim();
  } catch {
    return null;
  }
}

// Best-effort deletion of a local branch (part of orphan cleanup: after a worktree is removed, the branch
// `-b` created is left behind and a re-creation with `-b` would collide on the name).
// Failure is swallowed — a missing branch is the normal case; a genuine name collision still fails the
// re-creation and parks, which the caller handles (this is not the place to guess).
export function deleteBranch(repoDir: string, branch: string): void {
  try {
    runSync('git', ['-C', repoDir, 'branch', '-D', branch]);
  } catch {
    /* the branch does not exist, or deletion failed: do not guess */
  }
}

// The orphan-worktree sweep decision (a pure function, exported for unit tests). Given a set of on-disk
// worktrees (with each directory's mtime age) plus which sessions own them, decide which may be cleared.
// **Three conservative exemptions**: (1) one a non-terminal session is using (including STALLED / FAILED /
// dead-lettered, which are left for a human to inspect or retry); (2) one that is too new (age < minAgeMs: it
// may still be under construction with worktree_path not yet persisted, and clearing it would destroy the
// creation); (3) one with neither a SHIPPED owner nor a forge name (`-forge-`), so a user's or someone else's
// worktree is never deleted by mistake.
// **It clears only**: leftovers from a SHIPPED terminal state (where ackMerged's cleanup failed or never
// ran), and forge-named orphans with no owner at all (left behind by a database reset and the like).
export function planWorktreeSweep(args: {
  onDisk: { path: string; ageMs: number }[];
  shippedPaths: Set<string>; // the worktree_path of a SHIPPED session
  livePaths: Set<string>; // the worktree_path of a non-SHIPPED session (in use — never touched)
  minAgeMs: number; // the age-protection window
}): string[] {
  const out: string[] = [];
  for (const w of args.onDisk) {
    if (args.livePaths.has(w.path)) continue; // in use
    if (w.ageMs < args.minAgeMs) continue; // too new, it may still be under construction
    if (args.shippedPaths.has(w.path)) {
      out.push(w.path); // a SHIPPED leftover
      continue;
    }
    // A forge orphan with no owner: the current convention is the path segment `/.forge/worktrees/`; the
    // `<repo>-forge-<key>` name is the old convention, still cleaned up for compatibility.
    if (w.path.includes(WORKTREE_DIR_SEGMENT) || /-forge-/.test(basename(w.path))) out.push(w.path);
  }
  return out;
}
