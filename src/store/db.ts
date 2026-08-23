import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH, STATE_DIR } from '../root.ts';

let _db: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (_db) return _db;
  mkdirSync(STATE_DIR, { recursive: true });
  const d = new DatabaseSync(DB_PATH);
  d.exec('PRAGMA journal_mode = WAL;');
  // A backstop for write concurrency: with the daemon's single writer, the read-only backup connection and the
  // status page all reading at once, a checkpoint colliding with a write raises a transient SQLITE_BUSY.
  // This lets sqlite spin on the lock for up to 5s before erroring, absorbing those transients (nearly every
  // lock window is milliseconds long).
  d.exec('PRAGMA busy_timeout = 5000;');
  const schemaPath = resolve(dirname(fileURLToPath(import.meta.url)), 'schema.sql');
  // schema.sql is the **current** baseline, not a historical starting point: a freshly created database is
  // already in its latest shape and must not then be rewritten by the historical migrations (v1's RENAME COLUMN
  // would simply throw on a new database - the columns already carry the new names). So it first detects
  // whether this database is brand new, and after creating the baseline pushes user_version straight to the
  // latest, leaving the migrations to serve only **pre-existing** databases.
  const fresh = (d.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='session'").get() as { n: number }).n === 0;
  d.exec(readFileSync(schemaPath, 'utf8'));
  // A lightweight migration: add the new columns to an existing older database (CREATE TABLE IF NOT EXISTS
  // does not alter a table that already exists).
  for (const col of [
    "project_id TEXT NOT NULL DEFAULT 'demo'", // multi-project: existing rows in an older database are backfilled with the default project
    'adversarial_residual TEXT',
    'ref_num INTEGER',
    'poster_open_id TEXT', // added for pre-versioning databases; the v1 migration then renames it to poster_id
    'intake_msg_id TEXT',
    'status_msg_id TEXT',
    'size TEXT',
    'size_reason TEXT',
    'size_source TEXT',
    'prd_score INTEGER',
    'prd_score_dims TEXT',
    'prd_score_reason TEXT',
    'gate_a_round INTEGER',
    'gate_a_pending_input TEXT',
    'gate_a_residual TEXT',
    'gate_a_reviewer_session TEXT',
    'gate_a_fixer_session TEXT',
    'gate_a_adv_round INTEGER',
    'gate_a_fix_fail_streak INTEGER',
    'gate_b_reviewer_session TEXT',
    'gate_b_fixer_session TEXT',
    'gate_b_round INTEGER',
    'gate_b_fix_fail_streak INTEGER',
    'gate_b_pending_input TEXT',
    'gate_b_human_asks TEXT',
    'gate_b_reviewer_tokens TEXT',
    // Downstream Gate C
    'gate_c_requested_by TEXT',
    'gate_c_draft_path TEXT',
    'gate_c_round INTEGER',
    'gate_c_fix_fail_streak INTEGER',
    'gate_c_pending_input TEXT',
    'gate_c_human_asks TEXT',
    'gate_c_fixer_session TEXT',
    'gate_c_residual TEXT',
    'gate_c_cost_usd REAL',
    // Downstream Gate D
    'gate_d_requested_by TEXT',
    'gate_d_draft_path TEXT',
    'gate_d_round INTEGER',
    'gate_d_fix_fail_streak INTEGER',
    'gate_d_pending_input TEXT',
    'gate_d_human_asks TEXT',
    'gate_d_reviewer_session TEXT',
    'gate_d_fixer_session TEXT',
    'gate_d_reviewer_tokens TEXT',
    'gate_d_residual TEXT',
    'gate_d_cost_usd REAL',
    'gate_d_rollback_to TEXT', // the Gate D failed-rollback poison pill: the green HEAD sha the worktree must be reset to (set <=> the worktree is in an unconfirmed state)
    'gate_d_harden_round INTEGER', // how many test-hardening rounds have started (> 0 <=> it has entered GATE_D_HARDENING; planRetry uses this to return to HARDENING)
    'gate_d_green_sha TEXT', // the green HEAD sha pinned at Gate D LGTM (the hardening baseline; immutable, and never a moving ref)
    'gate_d_harden_verified_sha TEXT', // the HEAD sha whose CI went green after hardening (the guard for the idempotent fast path)
    // worktree / PR / merge
    'target_repos TEXT', // a JSON string[]: which code repos the implementation lands in (multi-repo ready; missing -> fall back to proj.repos[0])
    'legs TEXT', // a JSON Leg[]: one leg per repo (worktree, branch, CI, PR and every Gate D field - see src/gates/legs.ts)
    'worktree_path TEXT',
    'impl_branch TEXT',
    'base_shas TEXT',
    'pr_url TEXT',
    'pr_number INTEGER',
    'merge_readiness_path TEXT',
    'merged_by TEXT',
    'merged_at INTEGER',
    // The standalone entry point, plus room for multi-tenancy
    'source_kind TEXT',
    'issue_ref TEXT',
    'tenant_id TEXT',
    'retry_count INTEGER',
    'next_retry_at INTEGER',
    'reclaim_count INTEGER',
    'dead_letter INTEGER',
    'assignee TEXT',
    'assignee_source TEXT',
    'assigned_by TEXT',
    'assigned_at INTEGER',
    'assign_snapshot TEXT',
    'lease_owner TEXT', // so several runners cannot claim the same job: the runner id holding the lease
    'lease_expires_at INTEGER', // when the lease expires (ms)
  ]) {
    try {
      d.exec(`ALTER TABLE session ADD COLUMN ${col};`);
    } catch {
      /* the column already exists -> ignore */
    }
  }
  if (fresh) {
    // A brand-new database is already at the latest baseline -> stamp it with the latest version and skip every
    // historical migration (they only apply to pre-existing databases).
    d.exec(`PRAGMA user_version = ${latestMigrationVersion(MIGRATIONS)};`);
  }
  applyMigrations(d, MIGRATIONS); // once the baseline is aligned, run the versioned (user_version) non-additive migrations
  ensurePartialUniqueIndexes(d); // the unique indexes are created **after** the migrations, when the column names and values are final
  _db = d;
  return d;
}

// The two partial unique indexes that are the last gate against a concurrent race. They **must** come after
// applyMigrations: v1 is what renames the column to doc_ref, so creating the index earlier would certainly
// fail; and putting it inside v1's own SQL would be worse - if an older database holds duplicate values, the
// failed index creation rolls back the whole migration and the service simply will not start
// (test/store-legacy-duplicates.test.ts guards exactly this).
// So each is wrapped in its own try/catch: deduplication is still covered at the logic layer by findByDocRef /
// findByIssueRef, and once the duplicates are cleaned up by hand the index is created on the next start.
function ensurePartialUniqueIndexes(d: DatabaseSync): void {
  // PRD-level deduplication: concurrent inserts of the same doc_ref can only produce one row (a partial index -
  // sessions added by hand with no ref are unconstrained).
  try {
    d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_session_doc_ref ON session(doc_ref) WHERE doc_ref IS NOT NULL;');
  } catch {
    /* an older database holds duplicate doc_refs -> skip the unique index for now, pending manual cleanup */
  }
  // Standalone bare-issue deduplication: concurrent inserts of the same issue_ref can only produce one row.
  try {
    d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_session_issue_ref ON session(issue_ref) WHERE issue_ref IS NOT NULL;');
  } catch {
    /* an older database holds duplicate issue_refs -> skip the unique index for now, pending manual cleanup */
  }
}

// -- Versioned migrations (user_version, forward-only) --
// schema.sql creates the baseline for a new database; the "add the columns" block above idempotently aligns a
// pre-versioning database with the current baseline (adding columns only).
// Every **non-additive** change after that (renaming a column, backfilling data, dropping a table, rebuilding
// an index) is registered in MIGRATIONS: they advance monotonically by user_version, each in its own
// transaction, and a failure rolls back and stops at the last good version (forward-only; it never rolls back
// automatically).
// Adding one means appending { v: <previous + 1>, sql } to MIGRATIONS; v must be unique and monotonically
// increasing (a test guards this).
export interface Migration {
  v: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  // v1 (pluggable document sources): the three provider-named columns on session are renamed to
  // provider-neutral ones, and the doc token is upgraded to a **ref carrying its source prefix**. It is one
  // migration rather than two because they change the same table and the same set of call sites - splitting it
  // would mean two migrations and two repo-wide sweeps of the references, and the tidy-up phase that was
  // supposed to finish the job usually never comes.
  //
  // Why the token needs a prefix: with bare tokens under a unique index, sooner or later two sources emit the
  // same string, and two entirely unrelated requirements are judged duplicates (PRD-level deduplication is a
  // red line). All existing data came from Feishu, so 'feishu:' is added unconditionally; user_version
  // guarantees this migration runs **exactly once**, so the prefix cannot be applied twice.
  {
    v: 1,
    sql: `
      ALTER TABLE session RENAME COLUMN feishu_doc_token TO doc_ref;
      ALTER TABLE session RENAME COLUMN feishu_chat_id TO chat_id;
      ALTER TABLE session RENAME COLUMN poster_open_id TO poster_id;
      UPDATE session SET doc_ref = 'feishu:' || doc_ref WHERE doc_ref IS NOT NULL;
      DROP INDEX IF EXISTS idx_session_doc_token;
    `, // the new unique index is created by ensurePartialUniqueIndexes after the migrations - putting it here would let existing duplicates drag the whole migration down
  },
  // v2 (provider-neutral naming): the contract probe's dep changes from 'feishu' to 'im' - this probe checks
  // **whichever IM provider is currently in effect**, not one particular vendor. Without the rename, a
  // deployment running on Slack would be staring at a status-page row labelled "feishu" that is in fact
  // probing Slack. dep is the primary key, and 'im' cannot exist before v2, so there is no collision.
  { v: 2, sql: `UPDATE contract_probe SET dep = 'im' WHERE dep = 'feishu';` },
];

// The largest v in MIGRATIONS (0 for an empty list). A new database is stamped with this version right after
// its baseline is created, skipping the historical migrations.
export function latestMigrationVersion(migrations: Migration[]): number {
  return migrations.reduce((m, x) => (x.v > m ? x.v : m), 0);
}

// Apply every migration whose v is greater than the current user_version (in ascending order, each in its own
// transaction, bumping user_version one at a time). Returns the resulting version.
// It is written functionally (it never touches the module-level _db), so it can be unit-tested against any
// DatabaseSync.
export function applyMigrations(d: DatabaseSync, migrations: Migration[]): number {
  let cur = (d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (const m of [...migrations].sort((a, b) => a.v - b.v)) {
    if (m.v <= cur) continue;
    d.exec('BEGIN');
    try {
      d.exec(m.sql);
      d.exec(`PRAGMA user_version = ${m.v};`); // PRAGMA takes no placeholders; v is a monotonic integer defined in code, never external input
      d.exec('COMMIT');
      cur = m.v;
    } catch (e) {
      d.exec('ROLLBACK');
      throw new Error(`schema migration v${m.v} failed (rolled back; the database is still at v${cur}): ${String(e).slice(0, 200)}`);
    }
  }
  return cur;
}

// The prepared-statement cache: node:sqlite's prepare() recompiles the SQL every time, and recompiling hot
// queries (sessions.get and friends are called a dozen times per step) is pure waste. The compiled result is
// cached by SQL text and reused across calls. The cache is bound to the current db instance - if the connection
// were ever rebuilt (it should not be; _db is initialised once), the cache is cleared and rebuilt rather than
// reusing a handle from the old connection.
// Dynamic SQL (patch keyed by its column set, listByStates by its placeholder count) is cached by its full SQL
// text too, so the same shape naturally hits.
let _stmtDb: DatabaseSync | null = null;
const _stmts = new Map<string, StatementSync>();

export function prep(sql: string): StatementSync {
  const d = db();
  if (_stmtDb !== d) {
    _stmts.clear();
    _stmtDb = d;
  }
  let st = _stmts.get(sql);
  if (!st) {
    st = d.prepare(sql);
    _stmts.set(sql, st);
  }
  return st;
}
