// Gate C initialisation, artifact persistence, and assembly of the implementation context.
// setup: fetch to get a fresh baseSha for origin/<branch> (a read-only source of truth) -> delegate to the
// project's script to create an isolated worktree (pinned to baseSha) -> write the initial envelope.
// The worktree is where code edits, CI and the PR happen in isolation, so the main checkout is never polluted
// (which is why setup reads no working file from the main checkout and needs no anchorCheck).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { sessionLogDir } from '../util/render.ts';
import { projectForSession } from '../projects.ts';
import { refresh, assertFresh } from './repoFreshness.ts';
import { loadConfig } from '../config.ts';
import { createWorktree, removeWorktree, listWorktrees, deleteBranch, defaultWorktreePath, ensureWorktreeExcluded } from '../util/worktree.ts';
import { targetReposOf } from '../util/targetRepos.ts';
import { mkLeg, getLegs, setLegs, type Leg } from './legs.ts';
import { ImplEnvelopeSchema, GateBSchema } from './envelopes.ts';
import type { ImplEnvelope } from './envelopes.ts';
import { acceptanceMarkdown } from '../util/acceptance.ts';
import { slugify } from '../util/slug.ts';
import { store } from '../store/index.ts';
const { patch, appendEvent } = store; // take the local implementation methods through the SessionStore seam (free functions have no `this`, so destructuring is safe)
import type { Session } from '../types.ts';

export function gateCPaths(id: string): { draft: string; input: string } {
  const dir = sessionLogDir(id);
  return { draft: resolve(dir, 'gate-c.json'), input: resolve(dir, 'gatec-input.md') };
}


export async function persistGateC(s: Session, env: ImplEnvelope): Promise<void> {
  const { draft } = gateCPaths(s.id);
  mkdirSync(sessionLogDir(s.id), { recursive: true });
  writeFileSync(draft, JSON.stringify(env, null, 2));
  await patch(s.id, { gate_c_draft_path: draft });
}

// Missing or broken -> throw (the worker parks at GATE_C_FAILED). Never silently feed an empty shell through.
export function readImplEnvelope(s: Session): ImplEnvelope {
  if (!s.gate_c_draft_path || !existsSync(s.gate_c_draft_path)) throw new Error('the gate-c envelope is missing (the implementation state has been lost)');
  return ImplEnvelopeSchema.parse(JSON.parse(readFileSync(s.gate_c_draft_path, 'utf8')));
}

// The implementation context (the "what to build" fed to claude):
// - chained (source_kind=prd): the Gate B tech-design markdown + the outer-loop acceptance contract (the
//   definition of Done).
// - standalone (source_kind=issue): the issue body written to disk when the task was created
//   (gatec-input.md).
export function gateCContext(s: Session): string {
  // A chained run prefers the Gate B draft (it carries the acceptance outer-loop contract, which is Gate C's
  // deterministic target).
  if (s.gate_b_draft_path && existsSync(s.gate_b_draft_path)) {
    try {
      const env = GateBSchema.parse(JSON.parse(readFileSync(s.gate_b_draft_path, 'utf8')));
      const accept = acceptanceMarkdown(env.acceptance);
      return [
        '## Tech design (gate B final)',
        env.tech_design_markdown || env.summary || '(empty)',
        accept ? `## Outer-loop acceptance contract (definition of Done — the implementation must flip these from red to green)\n${accept}` : '',
      ].filter(Boolean).join('\n\n');
    } catch {
      /* nothing usable -> fall through to the input fallback below */
    }
  }
  const { input } = gateCPaths(s.id);
  if (existsSync(input)) return readFileSync(input, 'utf8');
  return '(no tech design / issue context — implement from the session title and the existing code; escalate anything uncertain via needs_human)';
}

// The **stable, unique identity** of the isolated worktree and the implementation branch: it must derive from
// session.id (= <slug>-<shortId>, unique as the PK and already carrying a readable slug prefix). It must never
// use s.slug - a slug is not unique (the schema has no UNIQUE constraint, so the same title yields the same
// slug). With a slug, setup's idempotent pre-clean would follow the same deterministic path and wrongly delete
// the worktree and forge/<slug> branch of another **live** session with the same slug, destroying the very
// isolation that makes "the thing under adversarial review is the worktree state" true (Codex B1).
// Deriving from the id makes the path session-private: the pre-clean can only ever hit this session's own
// crashed orphan, so it need not scan for references held by other sessions. Exported so a unit test can pin
// this invariant.
export function implIdentity(repoDir: string, id: string): { worktreePath: string; implBranch: string } {
  // Safe as a git ref and a path, bounded in length, **unique**, and identical for the same id every time (so a
  // pre-clean or a re-run reproduces the same path).
  // The key point: never use slugify with .slice(40) over the whole id as the key - a long slug would cut off
  // the trailing shortId, and shortId = Date.now() + randomness, so two same-slug sessions created at nearly
  // the same moment differ only in that tail; truncating makes their keys collide and the pre-clean deletes a
  // live worktree (Codex, fourth review, finding B).
  // Hence key = a readable prefix (slugify cut to 24, for display only) + a short hash of the whole id
  // (10 hex, which carries the uniqueness and does not depend on the shortId surviving truncation).
  const prefix = slugify(id).slice(0, 24).replace(/-+$/, '') || 'impl';
  const hash = createHash('sha1').update(id).digest('hex').slice(0, 10);
  const key = `${prefix}-${hash}`;
  return { worktreePath: defaultWorktreePath(repoDir, key), implBranch: `forge/${key}` };
}

// Create the isolated worktree for one repo (idempotent pre-clean + delegated creation + pinned to an
// immutable base sha). Throws on failure -> the caller parks at GATE_C_FAILED.
async function createLegWorktree(s: Session, proj: ReturnType<typeof projectForSession>, repo: string, baseSha: string, timeoutMs: number): Promise<Leg> {
  const repoDir = proj.repoPath(repo);
  ensureWorktreeExcluded(repoDir); // write .forge/ into that repo's local .git/info/exclude (never tracked, and never touching the product repo's .gitignore)
  if (!baseSha) throw new Error(`refresh returned no base sha for ${repo} - the worktree baseline cannot be pinned (refusing to build on a moving ref, or on another repo's baseline)`);
  // The identity derives from s.id (unique) - never from s.slug (not unique, so the pre-clean would delete
  // another session's live worktree, Codex B1). Different repos have different repoDirs, so the paths differ
  // naturally.
  const { worktreePath, implBranch } = implIdentity(repoDir, s.id);
  const addScript = proj.scripts.worktree_add ? resolve(proj.root, proj.scripts.worktree_add) : undefined;
  const removeScript = proj.scripts.worktree_remove ? resolve(proj.root, proj.scripts.worktree_remove) : undefined;
  // Idempotent pre-clean: the deterministic path already existing means a physical orphan from a previous run
  // that crashed between "create succeeded" and the DB write (the tree sits at base with no edits, so deleting
  // it loses nothing).
  if (existsSync(worktreePath) || listWorktrees(repoDir).includes(worktreePath)) {
    const rm = await removeWorktree({ repoDir, path: worktreePath, removeScript });
    deleteBranch(repoDir, implBranch);
    await appendEvent(s.id, 'gatec_worktree_orphan_cleaned', { repo, worktreePath, ok: rm.ok, output: rm.output.slice(0, 160) });
  }
  const r = await createWorktree({
    repoDir,
    path: worktreePath,
    branch: implBranch,
    baseCommitish: baseSha, // pin to an immutable sha rather than a moving ref (a concurrent fetch would drift the baseline away from base_sha, Codex B1)
    addScript,
    timeoutMs,
  });
  if (!r.ok) throw new Error(`failed to create the ${repo} worktree: ${r.output.slice(0, 300)}`);
  await appendEvent(s.id, 'gatec_worktree_ready', { repo, worktreePath, baseSha: baseSha.slice(0, 12), branch: implBranch });
  return mkLeg(repo, { worktree_path: worktreePath, impl_branch: implBranch, base_sha: baseSha });
}

// Point the session **entirely** at one leg: the implement/CI and PR adversarial loops both reuse the existing
// single-worktree machinery against s.worktree_path (= this leg). Switching legs resets **the full Gate C and
// Gate D loop state**, sets this leg's pr_url/pr_number, and writes this leg's gate-c.json envelope. This is
// the primitive that makes sequential driving work for both Gate C and Gate D - exactly one leg is active at a
// time, so the loop state can stay at session level (two legs must never run concurrently). Not clearing the
// residue on a switch would carry the previous leg's round counter, both-side sessions, green state and
// hardening pin into the next leg's review and hardening, so gate_d_* is zeroed too (during Gate C they are
// already null, which makes it a no-op).
export async function activateLeg(s: Session, leg: Leg): Promise<void> {
  await patch(s.id, {
    worktree_path: leg.worktree_path,
    impl_branch: leg.impl_branch,
    base_shas: JSON.stringify(leg.base_sha ? { [leg.repo]: leg.base_sha } : {}),
    pr_url: leg.pr_url, // during Gate C a leg has no PR yet (null); when Gate D re-points at a leg it carries that leg's PR (so review, merge and notifications all align with it)
    pr_number: leg.pr_number,
    gate_c_round: null,
    gate_c_fixer_session: null,
    gate_c_fix_fail_streak: null,
    gate_c_residual: null,
    gate_c_pending_input: null,
    gate_c_human_asks: null,
    gate_d_round: null,
    gate_d_reviewer_session: null,
    gate_d_fixer_session: null,
    gate_d_fix_fail_streak: null,
    gate_d_residual: null,
    gate_d_pending_input: null,
    gate_d_human_asks: null,
    gate_d_green_sha: null,
    gate_d_rollback_to: null,
    gate_d_harden_round: null,
    gate_d_harden_verified_sha: null,
    merge_readiness_path: null,
  });
  await persistGateC(s, {
    worktree_path: leg.worktree_path ?? '',
    impl_branch: leg.impl_branch ?? '',
    base_ref: `origin/${s.branch}`,
    base_sha: leg.base_sha ?? '',
    implemented: false,
    diff_stat: '',
    files_changed: [],
    ci_ok: false,
    ci_summary: '',
    last_summary: '',
  });
}

// The currently active leg: prefer the one matching worktree_path (the one the session points at); otherwise
// take the first leg that is not green yet. No legs -> null.
export function activeLeg(s: Pick<Session, 'worktree_path' | 'legs'>): Leg | null {
  const legs = getLegs(s);
  if (!legs.length) return null;
  return legs.find((l) => l.worktree_path && l.worktree_path === s.worktree_path) ?? legs.find((l) => !l.ci_ok) ?? null;
}

// setup: create an isolated worktree for **every target repo** (one leg per repo) -> point at the primary and
// enter the implement/CI loop. Throws on failure -> the worker parks at GATE_C_FAILED.
export async function runGateCSetup(s: Session): Promise<void> {
  const proj = projectForSession(s);
  const rt = loadConfig().runtime;
  if (!proj.scripts.ci) throw new Error("the target project has no scripts.ci configured - downstream CI must be delegated to the project's own script (never re-created inside forge, and never a bare build-tool invocation)");
  if (!proj.scripts.worktree_add) throw new Error('the target project has no scripts.worktree_add configured (a monorepo must go through its own worktree script)');

  const targets = targetReposOf(s, proj.repos); // chained runs take Gate A's repos_touched intersected with proj.repos, standalone runs take --repo; an empty set falls back to the first repo
  if (!targets.length) throw new Error('Gate C setup has no target repo (both target_repos and proj.repos are empty) - there is nothing to create a worktree in');
  // fetch the latest sha for origin/<branch> (never start from a stale sha; on failure assertFresh throws and
  // it is classified as transient, so it backs off and retries). One refresh covers every repo.
  const fresh = await refresh(s.branch, proj);
  assertFresh(fresh);

  const timeoutMs = (rt.gate_c?.ci_timeout_sec ?? 1800) * 1000;
  const legs: Leg[] = [];
  for (const repo of targets) {
    // Read this repo's sha precisely - never fall back to fresh.shas['.']: when a named repo has no key,
    // silently taking another repo's sha would build the tree on the wrong baseline (Codex SF).
    legs.push(await createLegWorktree(s, proj, repo, fresh.shas[repo] ?? '', timeoutMs));
  }
  await setLegs(s, legs);
  await activateLeg(s, legs[0]); // point at the primary leg (sequential driving: go green on one, switch to the next, and only enter AWAITING_GATE_D once all are green - see worker.afterGateC)
}
