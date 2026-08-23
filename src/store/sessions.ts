import { prep } from './db.ts';
import { canTransition } from '../statemachine/engine.ts';
import type { State } from '../statemachine/states.ts';
import type { Session } from '../types.ts';
import type { SessionStore, NewSession, EventRow } from './port.ts';

// The source of truth for NewSession / EventRow is port.ts (they are part of the SessionStore contract); they
// are re-exported here so the existing named imports keep working.
export type { NewSession, EventRow } from './port.ts';

// Exported for the consistency test: ALL_COLUMNS must be a subset of the session table's real columns
// (schema.sql plus the db.ts migrations), otherwise patch silently drops fields.
export const ALL_COLUMNS = [
  'id', 'ref_num', 'slug', 'title', 'state', 'project_id', 'branch', 'prd_url', 'prd_text_path',
  'chat_id', 'doc_ref', 'poster_id', 'intake_msg_id', 'status_msg_id',
  'size', 'size_reason', 'size_source',
  'prd_score', 'prd_score_dims', 'prd_score_reason',
  'gate_a_output_path', 'gate_a_session_id', 'gate_a_round', 'gate_a_pending_input', 'gate_a_residual',
  'gate_a_reviewer_session', 'gate_a_fixer_session', 'gate_a_adv_round', 'gate_a_fix_fail_streak',
  'gate_a_cost_usd', 'repo_shas_a', 'routing', 'confirmed_at', 'confirmed_by',
  'confirmed_notes', 'gate_b_requested_by', 'gate_b_draft_path', 'issue_specs_path',
  'repo_shas_b', 'adversarial_rounds', 'adversarial_residual', 'gate_b_cost_usd',
  'gate_b_reviewer_session', 'gate_b_fixer_session', 'gate_b_round', 'gate_b_fix_fail_streak', 'gate_b_pending_input',
  'gate_b_human_asks', 'gate_b_reviewer_tokens',
  // Downstream Gate C
  'gate_c_requested_by', 'gate_c_draft_path', 'gate_c_round', 'gate_c_fix_fail_streak', 'gate_c_pending_input',
  'gate_c_human_asks', 'gate_c_fixer_session', 'gate_c_residual', 'gate_c_cost_usd',
  // Downstream Gate D
  'gate_d_requested_by', 'gate_d_draft_path', 'gate_d_round', 'gate_d_fix_fail_streak', 'gate_d_pending_input',
  'gate_d_human_asks', 'gate_d_reviewer_session', 'gate_d_fixer_session', 'gate_d_reviewer_tokens',
  'gate_d_residual', 'gate_d_cost_usd', 'gate_d_rollback_to', 'gate_d_harden_round',
  'gate_d_green_sha', 'gate_d_harden_verified_sha',
  // worktree / PR / merge
  'target_repos', 'legs',
  'worktree_path', 'impl_branch', 'base_shas', 'pr_url', 'pr_number', 'merge_readiness_path',
  'merged_by', 'merged_at',
  // the standalone entry point, plus room for multi-tenancy
  'source_kind', 'issue_ref', 'tenant_id',
  'assignee', 'assignee_source', 'assigned_by', 'assigned_at', 'assign_snapshot',
  'go_by', 'go_at',
  'created_issues', 'techdesign_branch', 'error',
  'retry_count', 'next_retry_at', 'reclaim_count', 'dead_letter',
  'lease_owner', 'lease_expires_at', // the lease, so several runners cannot claim the same job
  'created_at', 'updated_at',
] as const;

// Like id / created_at / ref_num, project_id is fixed at insert and cannot be patched (a session's project
// binding never changes).
const SETTABLE = new Set(
  ALL_COLUMNS.filter((c) => c !== 'id' && c !== 'created_at' && c !== 'ref_num' && c !== 'project_id'),
);

// The free functions are now **async** (the SessionStore async contract): node:sqlite is synchronous
// underneath and is simply wrapped as async (no side effects, identical semantics) so a remoteApi becomes
// possible. The internal calls between them (create -> get/appendEvent, transition -> get/patch/appendEvent,
// and so on) all await.
export async function create(s: NewSession): Promise<Session> {
  const now = Date.now();
  // A human-readable number: a monotonic sequence number is assigned on arrival and shown as REQ-<ref_num>
  // throughout. In a single-threaded, single-process writer, MAX+1 has no race.
  const refNum = (prep('SELECT COALESCE(MAX(ref_num), 0) + 1 AS n FROM session').get() as { n: number }).n;
  prep(
    `INSERT INTO session (id, ref_num, slug, title, state, project_id, branch, prd_url, prd_text_path,
        chat_id, doc_ref, poster_id, intake_msg_id, source_kind, issue_ref, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    s.id, refNum, s.slug, s.title, s.state ?? 'INTAKE', s.project_id ?? 'demo', s.branch,
    s.prd_url ?? null, s.prd_text_path ?? null,
    s.chat_id ?? null, s.doc_ref ?? null,
    s.poster_id ?? null, s.intake_msg_id ?? null,
    s.source_kind ?? null, s.issue_ref ?? null, now, now,
  );
  await appendEvent(s.id, 'intake', { ref: `REQ-${refNum}`, slug: s.slug, prd_url: s.prd_url ?? null, source_kind: s.source_kind ?? 'prd', issue_ref: s.issue_ref ?? null });
  return (await get(s.id))!;
}

// The deduplication key for standalone implementation tasks: one session per issue_ref (running
// `implement --issue` again reuses the existing one).
export async function findByIssueRef(ref: string): Promise<Session | null> {
  if (!ref) return null;
  return (
    (prep('SELECT * FROM session WHERE issue_ref = ? ORDER BY created_at ASC LIMIT 1').get(ref) as unknown as Session) ?? null
  );
}

// create() hit the doc_ref unique index (a concurrent race: another insert of the same PRD got there first) ->
// fall back to the deduplication path. [a pure, synchronous predicate]
export function isDuplicateDocRefError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed/i.test(msg) && /doc_ref/i.test(msg);
}

// create() hit the issue_ref unique index (a concurrent race: another insert of the same standalone issue got
// there first) -> fall back to the deduplication path. [a pure, synchronous predicate]
export function isDuplicateIssueRefError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed/i.test(msg) && /issue_ref/i.test(msg);
}

export async function get(id: string): Promise<Session | null> {
  return (prep('SELECT * FROM session WHERE id = ?').get(id) as unknown as Session) ?? null;
}

export async function getBySlug(slug: string): Promise<Session | null> {
  return (
    (prep('SELECT * FROM session WHERE slug = ? ORDER BY created_at DESC LIMIT 1')
      .get(slug) as unknown as Session) ?? null
  );
}

export async function findByPrdUrl(url: string): Promise<Session | null> {
  return (
    (prep('SELECT * FROM session WHERE prd_url = ? LIMIT 1').get(url) as unknown as Session) ??
    null
  );
}

// Look up by document ref (the source of truth for PRD-level deduplication: every URL variant and query
// parameter has already been normalised to the same '<source>:<token>').
// The earliest row is taken as that PRD's canonical session, and a repeated submission reuses it.
export async function findByDocRef(ref: string): Promise<Session | null> {
  if (!ref) return null;
  return (
    (prep('SELECT * FROM session WHERE doc_ref = ? ORDER BY created_at ASC LIMIT 1')
      .get(ref) as unknown as Session) ?? null
  );
}

// Accepts an id or a slug, so the CLI can address sessions by slug
export async function resolve(idOrSlug: string): Promise<Session | null> {
  return (await get(idOrSlug)) ?? (await getBySlug(idOrSlug));
}

export async function listByStates(states: State[]): Promise<Session[]> {
  if (states.length === 0) return [];
  const placeholders = states.map(() => '?').join(',');
  return prep(`SELECT * FROM session WHERE state IN (${placeholders}) ORDER BY created_at ASC`)
    .all(...states) as unknown as Session[];
}

// The full list. With projectId given it returns only that project (query isolation: the panel, the cost view
// and the CLI all offer a per-project view); without it, the whole database.
// (**A red line**: the daemon's global actions - the poller, orphan sweeping, drift reconciliation - never pass
// a projectId; driving must never be isolated per project.)
export async function listAll(projectId?: string): Promise<Session[]> {
  if (projectId) {
    return prep('SELECT * FROM session WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as unknown as Session[];
  }
  return prep('SELECT * FROM session ORDER BY created_at DESC').all() as unknown as Session[];
}

// The project ids that appear in the database (deduplicated, alphabetical) - for the project filter dropdown
// in the panel and CLI, which lists only projects that actually have requirements.
export async function distinctProjects(): Promise<string[]> {
  const rows = prep('SELECT DISTINCT project_id AS p FROM session WHERE project_id IS NOT NULL ORDER BY project_id').all() as unknown as { p: string }[];
  return rows.map((r) => r.p);
}

// A count per state (used by the health dashboard and the active-gate count). One aggregate query, so it never
// fetches the whole table.
export async function countByState(): Promise<Record<string, number>> {
  const rows = prep('SELECT state, COUNT(*) AS n FROM session GROUP BY state')
    .all() as unknown as { state: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.state] = r.n;
  return out;
}

export async function countByStates(states: State[]): Promise<number> {
  if (states.length === 0) return 0;
  const placeholders = states.map(() => '?').join(',');
  const row = prep(`SELECT COUNT(*) AS n FROM session WHERE state IN (${placeholders})`)
    .get(...states) as { n: number };
  return row.n;
}

export async function patch(id: string, fields: Partial<Session>): Promise<Session> {
  const keys = Object.keys(fields).filter((k) => SETTABLE.has(k as never));
  if (keys.length === 0) return (await get(id))!;
  const setSql = keys.map((k) => `${k} = ?`).join(', ');
  const vals = keys.map((k) => {
    const v = (fields as Record<string, unknown>)[k];
    return v === undefined ? null : (v as string | number | null);
  });
  prep(`UPDATE session SET ${setSql}, updated_at = ? WHERE id = ?`).run(...vals, Date.now(), id);
  return (await get(id))!;
}

export async function transition(id: string, to: State, fields: Partial<Session> = {}): Promise<Session> {
  const s = await get(id);
  if (!s) throw new Error(`session not found: ${id}`);
  if (!canTransition(s.state, to)) {
    throw new Error(`illegal transition ${s.state} → ${to} (session ${id})`);
  }
  const res = await patch(id, { ...fields, state: to });
  if (s.state !== to) await appendEvent(id, 'transition', { from: s.state, to });
  return res;
}

export async function appendEvent(id: string, kind: string, detail?: unknown): Promise<void> {
  prep('INSERT INTO event_log (session_id, ts, kind, detail) VALUES (?,?,?,?)')
    .run(id, Date.now(), kind, detail != null ? JSON.stringify(detail) : null);
}

export async function events(id: string): Promise<EventRow[]> {
  return prep('SELECT ts, kind, detail FROM event_log WHERE session_id = ? ORDER BY id ASC')
    .all(id) as unknown as EventRow[];
}

// When an event of this kind last happened for this session (used for alert debouncing and reconciliation);
// null if never.
// It hits the composite index idx_event_session_kind_ts(session_id, kind, ts), finding MAX inside the index
// rather than scanning every event for that session.
export async function lastEventTs(id: string, kind: string): Promise<number | null> {
  const row = prep('SELECT MAX(ts) AS ts FROM event_log WHERE session_id = ? AND kind = ?')
    .get(id, kind) as { ts: number | null };
  return row.ts ?? null;
}

// Atomically claim due jobs (so several runners cannot claim the same one): a single `UPDATE ... RETURNING`
// takes and returns "the due jobs this runner may claim" in one step.
// The claimable set is: state in `states`, and the job is unowned, its lease expired, or this runner already
// holds it (a renewal). **A lease another runner still holds is excluded, so nothing is ever double-claimed.**
// It is atomic across processes: sqlite takes a write lock for an UPDATE and statements are atomic; with a
// single-process control plane every claim goes through the same connection and is naturally serialised.
//
// **limit = how many this runner can actually start running concurrently this round (max_parallel)**, taken
// FIFO (created_at ASC). The key point: **claim only what you will start this round** - never lease the whole
// backlog at once. Otherwise the queued-but-not-started jobs count down their TTL from the moment they were
// claimed, and if a long step earlier in the batch pushes them past it, another runner treats them as expired
// and re-claims them -> the same worktree runs twice; on top of which one runner monopolises the whole backlog
// and the others get nothing.
// With each runner claiming at most `limit`, the backlog spreads naturally; and since each claimed job starts
// this round (no queueing), the lease window is about one step long, which is what makes "TTL >= one step"
// the right calibration.
// **Never write updated_at**: a lease is orchestration bookkeeping, not a business state change - bumping it
// would refresh remindStuck's idle check, which would read as "something just happened here" and mean the
// reminder never fires.
export async function leaseClaim(states: State[], runnerId: string, ttlMs: number, limit: number): Promise<Session[]> {
  if (states.length === 0 || limit < 1) return [];
  const now = Date.now();
  const placeholders = states.map(() => '?').join(',');
  // sqlite's UPDATE has no LIMIT clause (unless specially compiled), so a subquery picks at most `limit` ids in
  // FIFO order first, and the UPDATE ... RETURNING then acts on those.
  return prep(
    `UPDATE session SET lease_owner = ?, lease_expires_at = ?
       WHERE id IN (
         SELECT id FROM session
           WHERE state IN (${placeholders})
             AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ? OR lease_owner = ?)
           ORDER BY created_at ASC
           LIMIT ?
       )
     RETURNING *`,
  ).all(runnerId, now + ttlMs, ...states, now, runnerId, limit) as unknown as Session[];
}

// -- The localSqlite adapter --
// Bundles the free functions above (the direct local-sqlite implementation) into a SessionStore for the
// selection point in store/index.ts to wire up.
// The free functions are still exported individually (so existing imports keep working during the migration;
// once it is finished the core only goes through `store` and this module is simply "the localSqlite
// implementation").
// None of these functions use `this` (they are plain prep calls), so referencing or destructuring them as
// object methods is safe.
export const localSqliteStore: SessionStore = {
  create,
  findByIssueRef,
  isDuplicateDocRefError,
  isDuplicateIssueRefError,
  get,
  getBySlug,
  findByPrdUrl,
  findByDocRef,
  resolve,
  listByStates,
  listAll,
  distinctProjects,
  countByState,
  countByStates,
  patch,
  transition,
  appendEvent,
  events,
  lastEventTs,
  leaseClaim,
};
