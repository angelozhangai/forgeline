// Choosing the target code repo (the top rule: the repository is the most specific unit, and the
// implementation anchors to the repo the requirement really changes). Pure logic with no heavy dependencies
// (it imports types only) — kept as its own module so that when actions/intake reference it they do **not**
// drag gateC/worktree into a partially mocked test graph (otherwise a downstream test that mock.module's part
// of worktree/gateC fails to link on a missing export). This is the source of truth, and
// gateC.runGateCSetup takes its primary from here too.
import type { Session } from '../types.ts';

// Normalise through repoMap first (Gate A's repos_touched holds **letters** C/U/A/E — see output-contract.md
// and the gate-b prompt), then intersect with projRepos, deduplicating while preserving order; an empty
// result falls back to the first repo (the implementation must never be left with nowhere to land).
// `repoMap[t] ?? t` is compatible in both directions — a letter maps to a repo name, and something that is
// already a repo name passes through (the GATE_A_CONTRACT example once used repo names, so a model may emit
// either; a standalone --repo may also be given a name or a letter).
// ⚠️ Comparing letters against repo names with no repoMap means `["U"]`/`["A"]` match nothing and silently
// fall back to the first repo — the mis-anchoring bug Codex raised as a blocker.
export function resolveTargetRepos(touched: readonly string[], projRepos: readonly string[], repoMap: Record<string, string> = {}): string[] {
  const normalized = touched.map((t) => repoMap[t] ?? t);
  const uniq = [...new Set(normalized.filter((r) => projRepos.includes(r)))];
  return uniq.length ? uniq : projRepos[0] ? [projRepos[0]] : [];
}

// This session's target repos (read from the target_repos json; malformed or empty falls back to
// proj.repos[0]). Phase 1 uses the primary (the first) only; one tree per repo for multi-repo is phase 2.
export function targetReposOf(s: Pick<Session, 'target_repos'>, projRepos: readonly string[]): string[] {
  let parsed: unknown = [];
  try {
    if (s.target_repos) parsed = JSON.parse(s.target_repos);
  } catch {
    parsed = [];
  }
  return resolveTargetRepos(Array.isArray(parsed) ? (parsed as string[]) : [], projRepos);
}

// The primary target repo (the one the worktree and branch anchor to, and the one cleanup locates after a
// merge). Missing -> proj.repos[0] -> '.'.
export function primaryTargetRepo(s: Pick<Session, 'target_repos'>, projRepos: readonly string[]): string {
  return targetReposOf(s, projRepos)[0] ?? projRepos[0] ?? '.';
}
