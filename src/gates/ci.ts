// The **deterministic CI gate** for downstream Gate C / Gate D, plus worktree git read/write helpers.
// CI is the reviewer that replaces codex inside reviewFixLoop: it runs the CI script the target project
// delegates (forge-ci.sh), where green = LGTM and red = CHANGES.
// CI is never rebuilt inside forge and never invoked as a bare nx — with no scripts.ci configured, it counts
// as "cannot run" and goes to a human.
import { run, runSync } from '../util/proc.ts';
import { interp } from '../util/worktree.ts';

function tail(s: string, n = 4000): string {
  const t = s.trim();
  return t.length > n ? t.slice(-n) : t;
}

export interface CiResult {
  ok: boolean; // exit code 0 (fully green)
  ran: boolean; // the script actually started (false = spawn failure / timeout / not configured -> the caller parks rather than treating it as red)
  summary: string; // truncated stdout+stderr (fed to claude for the fix when red; kept as a record when green)
}

// Run the delegated CI script in the worktree (cwd = the worktree, so the script locates the repo root — that
// worktree — from its own position).
// ciScriptAbs missing (the project has no scripts.ci) -> ran:false (never fall back to a bare nx; downstream
// must delegate to the project's CI).
export async function runCi(
  worktreePath: string,
  ciScriptAbs: string | undefined,
  opts: { timeoutMs?: number; base?: string } = {},
): Promise<CiResult> {
  if (!ciScriptAbs) {
    return { ok: false, ran: false, summary: 'The target project has no scripts.ci configured — downstream must delegate to the project\'s own local CI script (never rebuild it in forge or run a bare nx)' };
  }
  const timeoutMs = opts.timeoutMs ?? 1_800_000;
  const baseArgs = opts.base ? ['--base', opts.base] : [];
  const [bin, args] = interp(ciScriptAbs, ['affected', ...baseArgs]);
  const r = await run(bin, args, { cwd: worktreePath, timeoutMs });
  if (r.code === null) return { ok: false, ran: false, summary: `The CI script could not start: ${tail(r.stderr)}` };
  if (r.timedOut) return { ok: false, ran: false, summary: `CI timed out (${Math.round(timeoutMs / 1000)}s)` };
  return { ok: r.code === 0, ran: true, summary: tail(r.stdout + r.stderr) };
}

// -- Worktree git helpers (small synchronous commands; they degrade rather than throw, and never press ahead) --

// Whether base..HEAD has commits (i.e. whether the implementation has landed as a commit).
export function hasCommitsSince(worktreePath: string, baseSha: string): boolean {
  try {
    return runSync('git', ['-C', worktreePath, 'rev-list', '--count', `${baseSha}..HEAD`]).trim() !== '0';
  } catch {
    return false;
  }
}

// The --stat summary of base..HEAD (persisted into ImplEnvelope for display).
export function diffStatSince(worktreePath: string, baseSha: string): string {
  try {
    return tail(runSync('git', ['-C', worktreePath, 'diff', '--stat', `${baseSha}..HEAD`]).trim(), 2000);
  } catch {
    return '';
  }
}

// The list of files changed in base..HEAD.
export function changedFilesSince(worktreePath: string, baseSha: string): string[] {
  try {
    return runSync('git', ['-C', worktreePath, 'diff', '--name-only', `${baseSha}..HEAD`])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Push the worktree's current branch to origin (Gate D: update the PR branch once CI is green). The upstream
// was already set by the `push -u` that opened the PR.
// On failure it returns ok:false (the caller parks on that; never pretend the push succeeded).
export function pushWorktree(worktreePath: string): { ok: boolean; output: string } {
  try {
    const out = runSync('git', ['-C', worktreePath, 'push']);
    return { ok: true, output: out.slice(0, 300) };
  } catch (e) {
    return { ok: false, output: String(e).slice(0, 300) };
  }
}

// Whether the worktree is clean (no uncommitted changes). Confirmed before CI and before a push: what CI
// verified and what gets pushed must both be the commit at HEAD rather than a dirty working tree (otherwise a
// green CI proves nothing about the pushed commit). If it cannot be determined, conservatively call it dirty
// (false), forcing the caller to park.
export function worktreeClean(worktreePath: string): boolean {
  try {
    return runSync('git', ['-C', worktreePath, 'status', '--porcelain']).trim() === '';
  } catch {
    return false;
  }
}

// Roll the worktree back to a given commit and clear untracked files (reset --hard + clean -fd; -fd leaves
// .gitignore'd paths alone, so node_modules and friends survive).
// Used when a Gate D revision did not reach "CI green and pushed" — never leave a red or unverified commit at
// HEAD, where the next tick's review-first codex pass could LGTM it straight through and bypass the
// CI-green precondition.
// A zero exit from reset/clean does **not** mean genuinely clean: clean -fd skips nested git repos and
// submodule leftovers and still exits 0. So the porcelain status is **checked again** after the reset, and a
// non-empty result is ok:false — "the reset succeeded" must mean "the tree really is clean at that sha", or
// the caller would let a still-dirty tree through into review.
// On failure it returns ok:false and the caller escalates to a parked state (it must not pretend the reset
// worked).
export function resetWorktree(worktreePath: string, sha: string): { ok: boolean; output: string } {
  try {
    runSync('git', ['-C', worktreePath, 'reset', '--hard', sha]);
    runSync('git', ['-C', worktreePath, 'clean', '-fd']);
    const dirty = runSync('git', ['-C', worktreePath, 'status', '--porcelain']).trim();
    if (dirty) return { ok: false, output: `The worktree is still not clean after the reset (nested repo / submodule leftovers?): ${dirty.slice(0, 200)}` };
    return { ok: true, output: '' };
  } catch (e) {
    return { ok: false, output: String(e).slice(0, 300) };
  }
}

// Land everything claude changed in the worktree this round as one commit (forge owns git; claude only writes
// code).
// --no-verify skips the target project's husky hooks (this is a WIP commit; the real gate is forge-ci.sh), and
// an explicit author guards against a worktree with no user configuration.
// The two dimensions ok/committed distinguish three states — crucially, "the commit failed" must never be
// conflated with "there was nothing to commit":
//  · ok:false                 the commit failed (a git error; `add -A` may already have staged the changes, so
//                             the worktree is dirty) -> the caller must park.
//  · ok:true, committed:false nothing changed (the worktree was already clean, with nothing to commit).
//  · ok:true, committed:true  a commit landed normally (and the worktree is clean afterwards).
export function commitWorktree(worktreePath: string, message: string): { ok: boolean; committed: boolean; output: string } {
  try {
    runSync('git', ['-C', worktreePath, 'add', '-A']);
    const status = runSync('git', ['-C', worktreePath, 'status', '--porcelain']).trim();
    if (!status) return { ok: true, committed: false, output: 'nothing changed, commit skipped' };
    const out = runSync('git', [
      '-C', worktreePath,
      '-c', 'user.name=forge',
      '-c', 'user.email=forge@local',
      'commit', '-m', message, '--no-verify',
    ]);
    return { ok: true, committed: true, output: out.slice(0, 500) };
  } catch (e) {
    return { ok: false, committed: false, output: String(e).slice(0, 300) };
  }
}
