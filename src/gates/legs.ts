// The multi-repo "one leg per repo" model: a requirement that touches N repos becomes N legs, each with its
// own worktree, implementation branch, baseSha, CI, PR and Gate D re-review. This is the runtime carrier of
// the top rule "a worktree belongs to the specific repo it changes" - every leg anchors one concrete repo, and
// multiple repos are never squeezed into repos[0] again.
//
// Stored as session.legs (a JSON string[], matching this repo's existing JSON-column convention alongside
// base_shas / created_issues / residual, rather than introducing a new table).
// A single-repo requirement is exactly one leg; downstream Gate C / Gate D / merged iterate over the legs.
import { store } from '../store/index.ts';
const { patch, get } = store; // take the local implementation methods through the SessionStore seam (free functions have no `this`, so destructuring is safe)
import type { Session } from '../types.ts';

export interface Leg {
  repo: string; // the repo directory name (the concrete repo this leg anchors)
  // -- Gate C: isolated worktree + implementation + local CI --
  worktree_path: string | null; // <repo>/.forge/worktrees/<key>; null = no worktree created yet (pending)
  impl_branch: string | null; // forge/<key>
  base_sha: string | null; // the immutable origin/<branch> sha the worktree is anchored to
  gate_c_round: number | null;
  gate_c_fixer_session: string | null; // the claude implementation session_id (resumed to continue the work)
  gate_c_fix_fail_streak: number | null;
  gate_c_residual: string | null;
  ci_ok: boolean | null; // whether this leg's local CI is green
  // -- Gate D: open the PR + codex reviews the diff / claude revises + test hardening --
  pr_url: string | null;
  pr_number: number | null;
  gate_d_round: number | null;
  gate_d_reviewer_session: string | null; // the codex thread_id
  gate_d_fixer_session: string | null; // the session_id of the claude that edits the worktree
  gate_d_fix_fail_streak: number | null;
  gate_d_residual: string | null;
  gate_d_green_sha: string | null; // the green HEAD sha pinned at LGTM
  gate_d_rollback_to: string | null; // the poison pill left behind when a rollback fails
  gate_d_harden_round: number | null;
  gate_d_harden_verified_sha: string | null;
  merge_readiness_path: string | null;
  merged: boolean | null; // whether this leg's PR has been merged by a human and verified
}

// Create a leg (it anchors the repo name only; every other field is empty = pending, and gets filled in as the
// worktree is created and the implementation proceeds). A pure function, exported for unit tests.
export function mkLeg(repo: string, fields: Partial<Leg> = {}): Leg {
  return {
    repo,
    worktree_path: null,
    impl_branch: null,
    base_sha: null,
    gate_c_round: null,
    gate_c_fixer_session: null,
    gate_c_fix_fail_streak: null,
    gate_c_residual: null,
    ci_ok: null,
    pr_url: null,
    pr_number: null,
    gate_d_round: null,
    gate_d_reviewer_session: null,
    gate_d_fixer_session: null,
    gate_d_fix_fail_streak: null,
    gate_d_residual: null,
    gate_d_green_sha: null,
    gate_d_rollback_to: null,
    gate_d_harden_round: null,
    gate_d_harden_verified_sha: null,
    merge_readiness_path: null,
    merged: null,
    ...fields,
  };
}

// Read session.legs (broken or empty -> []). A pure function, exported for unit tests.
export function getLegs(s: Pick<Session, 'legs'>): Leg[] {
  if (!s.legs) return [];
  try {
    const arr = JSON.parse(s.legs);
    return Array.isArray(arr) ? (arr as Leg[]) : [];
  } catch {
    return [];
  }
}

// Build the initial legs from the target repos (order preserved, the first repo being the primary). Each leg's
// worktree and branch are filled in by the builder. A pure function, exported for unit tests.
export function buildLegs(repos: readonly string[], builder: (repo: string, index: number) => Partial<Leg>): Leg[] {
  return repos.map((repo, i) => mkLeg(repo, builder(repo, i)));
}

// Persist the legs (replacing the whole set).
export async function setLegs(s: Pick<Session, 'id'>, legs: Leg[]): Promise<void> {
  await patch(s.id, { legs: JSON.stringify(legs) });
}

// The sequential-driving "what next" decision (a pure function, exported for unit tests): treat the currently
// active leg as having just gone CI-green, and return the next leg repo that is **not green yet and already
// has a worktree**; none -> null (all green = Gate C is done). afterGateC uses this to activate the next leg or
// to advance to AWAITING_GATE_D. Two legs must never run concurrently.
export function planLegAdvance(legs: Leg[], activeRepo: string | null): { nextRepo: string | null } {
  const after = legs.map((l) => (l.repo === activeRepo ? { ...l, ci_ok: true } : l));
  return { nextRepo: after.find((l) => !l.ci_ok && l.worktree_path)?.repo ?? null };
}

// The Gate D sequential-driving "what next" decision (a pure function, exported for unit tests): treat the
// currently active leg as having just finished hardening (Gate D's terminal state), and return the next leg
// repo that **has a PR open, has a worktree, and has not been through Gate D yet (no hardening-verified sha)**;
// none -> null (every leg is through Gate D = the change can move to merge-ready).
// Same shape as planLegAdvance - Gate C marks completion with ci_ok, Gate D with gate_d_harden_verified_sha
// (which is only pinned once the hardening CI is green). Two legs must never run concurrently.
export function planGateDAdvance(legs: Leg[], activeRepo: string | null): { nextRepo: string | null } {
  const after = legs.map((l) => (l.repo === activeRepo ? { ...l, gate_d_harden_verified_sha: l.gate_d_harden_verified_sha ?? 'done' } : l));
  return { nextRepo: after.find((l) => !l.gate_d_harden_verified_sha && l.pr_url && l.worktree_path)?.repo ?? null };
}

// Update one leg (located by repo) and persist it; if the repo is not present nothing changes (it never
// speculatively adds one).
// It **re-reads** session.legs from the DB (by id) and never uses the stale legs snapshot on the `s` argument -
// otherwise patching several legs in a row from the same `s` would have them overwrite each other (which is
// exactly what openReviewPr does when it opens a PR per leg). Read the latest -> change one -> persist.
export async function patchLeg(s: Pick<Session, 'id'>, repo: string, fields: Partial<Leg>): Promise<Leg[]> {
  const cur = await get(s.id);
  const legs = getLegs(cur ?? { legs: null }).map((l) => (l.repo === repo ? { ...l, ...fields } : l));
  await setLegs(s, legs);
  return legs;
}
