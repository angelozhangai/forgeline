// The versioned migrator (applyMigrations): it advances monotonically by user_version, runs each migration in
// its own transaction, and on failure rolls back and stops at the last good version.
// It runs synthetic migrations against an in-memory DatabaseSync rather than the real database - verifying the
// mechanism itself, not mirroring its internal branches.
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, latestMigrationVersion, MIGRATIONS } from '../src/store/db.ts';

function uv(d: DatabaseSync): number {
  return (d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}
function tables(d: DatabaseSync): string[] {
  return (d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
}

test('a brand-new database (user_version=0) applies every migration in ascending v order and bumps the version (even when they are passed out of order)', () => {
  const d = new DatabaseSync(':memory:');
  const v = applyMigrations(d, [
    { v: 2, sql: 'CREATE TABLE b(x);' }, // passed out of order
    { v: 1, sql: 'CREATE TABLE a(x);' },
  ]);
  assert.equal(v, 2);
  assert.equal(uv(d), 2);
  assert.deepEqual(tables(d), ['a', 'b']);
});

test('already at the latest version (user_version >= max) -> everything is skipped with no side effects (running the same list again replays nothing)', () => {
  const d = new DatabaseSync(':memory:');
  applyMigrations(d, [{ v: 1, sql: 'CREATE TABLE a(x);' }]);
  // Run the same one again: v1 <= cur (1) so it is skipped; had it not been, creating table a again would throw
  const v = applyMigrations(d, [{ v: 1, sql: 'CREATE TABLE a(x);' }]);
  assert.equal(v, 1);
  assert.equal(uv(d), 1);
});

test('only migrations with v greater than the current version are applied (it moves forward incrementally and never replays what is done)', () => {
  const d = new DatabaseSync(':memory:');
  applyMigrations(d, [{ v: 1, sql: 'CREATE TABLE a(x);' }]); // -> v1
  const v = applyMigrations(d, [
    { v: 1, sql: 'CREATE TABLE a(x);' }, // skipped (already <= 1); otherwise creating a again would throw
    { v: 2, sql: 'CREATE TABLE b(x);' }, // applied
  ]);
  assert.equal(v, 2);
  assert.equal(uv(d), 2);
  assert.deepEqual(tables(d), ['a', 'b']);
});

test('a failed migration -> roll back, throw, and stay at the last good version (forward-only safety)', () => {
  const d = new DatabaseSync(':memory:');
  assert.throws(
    () =>
      applyMigrations(d, [
        { v: 1, sql: 'CREATE TABLE a(x);' }, // succeeds -> v1 (its own transaction, already committed)
        { v: 2, sql: 'THIS IS NOT VALID SQL;' }, // fails -> rolled back, staying at v1
      ]),
    /migration v2 failed/,
  );
  assert.equal(uv(d), 1); // v1 landed, and v2 did not pollute the version
  assert.deepEqual(tables(d), ['a']); // only v1's table; v2 rolled back cleanly
});

test('the production MIGRATIONS list is well-formed: v is monotonically increasing with no duplicates (guarding against a mistyped number)', () => {
  const vs = MIGRATIONS.map((m) => m.v);
  assert.deepEqual(vs, [...vs].sort((a, b) => a - b)); // ascending
  assert.equal(new Set(vs).size, vs.length); // no duplicates
});

test('latestMigrationVersion: an empty list -> 0; otherwise the largest v (a new database is stamped with this and skips the historical migrations)', () => {
  assert.equal(latestMigrationVersion([]), 0);
  assert.equal(latestMigrationVersion([{ v: 3, sql: '' }, { v: 1, sql: '' }]), 3);
  assert.equal(latestMigrationVersion(MIGRATIONS), Math.max(...MIGRATIONS.map((m) => m.v)));
});

// -- v1: provider-named columns -> provider-neutral ones, and the doc token upgraded to a ref carrying its
//    source prefix --
// The real MIGRATIONS are run against a fixture in the **shape of a pre-existing older database**, which is the
// only place the upgrade path can be verified automatically.
// A minimal session table is hand-built with the old column names (the migration only touches those three
// columns and that one index).
function legacyDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY,
    feishu_chat_id TEXT,
    feishu_doc_token TEXT,
    poster_open_id TEXT,
    issue_ref TEXT
  );`);
  d.exec('CREATE UNIQUE INDEX idx_session_doc_token ON session(feishu_doc_token) WHERE feishu_doc_token IS NOT NULL;');
  // v2 touches this table, and a real older database certainly has it (schema.sql creates it at build time).
  d.exec('CREATE TABLE contract_probe (dep TEXT PRIMARY KEY, ok INTEGER, detail TEXT, raw TEXT, checked_at INTEGER);');
  return d;
}
const cols = (d: DatabaseSync): string[] =>
  (d.prepare("SELECT name FROM pragma_table_info('session') ORDER BY name").all() as { name: string }[]).map((r) => r.name);
const indexes = (d: DatabaseSync): string[] =>
  (d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

test('v1: all three columns are renamed in one go, and every existing doc token gains the feishu: prefix', () => {
  const d = legacyDb();
  d.prepare('INSERT INTO session (id, feishu_chat_id, feishu_doc_token, poster_open_id) VALUES (?,?,?,?)').run('s1', 'oc_1', 'TOKA', 'ou_pm');
  d.prepare('INSERT INTO session (id, feishu_doc_token) VALUES (?,?)').run('s2', 'TOKB');
  d.prepare('INSERT INTO session (id, feishu_doc_token) VALUES (?,?)').run('s3', null); // added by hand: it never had a document

  assert.equal(applyMigrations(d, MIGRATIONS), latestMigrationVersion(MIGRATIONS));

  const names = cols(d);
  for (const c of ['chat_id', 'doc_ref', 'poster_id']) assert.ok(names.includes(c), `the column ${c} is missing`);
  for (const c of ['feishu_chat_id', 'feishu_doc_token', 'poster_open_id']) assert.ok(!names.includes(c), `the old column ${c} is still there`);

  // node:sqlite returns null-prototype objects, and deepStrictEqual fails on the differing prototype -> flatten
  // them into plain objects before comparing.
  const rows = (d.prepare('SELECT id, chat_id, doc_ref, poster_id FROM session ORDER BY id').all() as Record<string, unknown>[]).map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { id: 's1', chat_id: 'oc_1', doc_ref: 'feishu:TOKA', poster_id: 'ou_pm' },
    { id: 's2', chat_id: null, doc_ref: 'feishu:TOKB', poster_id: null },
    { id: 's3', chat_id: null, doc_ref: null, poster_id: null }, // a NULL must not be concatenated into 'feishu:null'
  ]);
});

test('v1: the old doc-token unique index is removed (its column is gone, so leaving it would certainly break)', () => {
  const d = legacyDb();
  applyMigrations(d, MIGRATIONS);
  assert.ok(!indexes(d).includes('idx_session_doc_token'));
});

test('v1: running it again does not apply the prefix twice (user_version guarantees it runs exactly once)', () => {
  const d = legacyDb();
  d.prepare('INSERT INTO session (id, feishu_doc_token) VALUES (?,?)').run('s1', 'TOKA');
  applyMigrations(d, MIGRATIONS);
  applyMigrations(d, MIGRATIONS); // run it a second time
  assert.equal((d.prepare('SELECT doc_ref FROM session WHERE id = ?').get('s1') as { doc_ref: string }).doc_ref, 'feishu:TOKA');
});

test('v1: deduplication by doc_ref still works after the upgrade - two rows with the same ref are blocked by the unique index', () => {
  const d = legacyDb();
  d.prepare('INSERT INTO session (id, feishu_doc_token) VALUES (?,?)').run('s1', 'TOKA');
  applyMigrations(d, MIGRATIONS);
  // The migration only removes the old index; the new one is created by db()'s ensurePartialUniqueIndexes (so
  // duplicate values in an older database cannot drag the migration down).
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_session_doc_ref ON session(doc_ref) WHERE doc_ref IS NOT NULL;');
  assert.throws(
    () => d.prepare('INSERT INTO session (id, doc_ref) VALUES (?,?)').run('s2', 'feishu:TOKA'),
    /UNIQUE constraint failed/,
  );
  // Rows with no document are unconstrained (it is a partial index): many can be added by hand
  d.prepare('INSERT INTO session (id, doc_ref) VALUES (?,?)').run('m1', null);
  d.prepare('INSERT INTO session (id, doc_ref) VALUES (?,?)').run('m2', null);
});

// -- v2: the contract probe's dep changes from 'feishu' to 'im' --
// This probe checks **whichever IM provider is currently in effect**, not one particular vendor. Without the
// rename, a deployment running on Slack would be staring at a probe row labelled "feishu" that is in fact
// probing Slack.
test('v2: an existing contract_probe row for feishu is renamed to im, and the other rows are untouched', () => {
  const d = legacyDb();
  const ins = d.prepare('INSERT INTO contract_probe (dep, ok, detail, checked_at) VALUES (?,?,?,?)');
  ins.run('feishu', 1, 'the im/v1/messages pagination envelope is intact', 100);
  ins.run('codex', 0, 'thread.started is missing', 100);
  applyMigrations(d, MIGRATIONS);
  const rows = (d.prepare('SELECT dep, detail FROM contract_probe ORDER BY dep').all() as Record<string, unknown>[]).map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { dep: 'codex', detail: 'thread.started is missing' },
    { dep: 'im', detail: 'the im/v1/messages pagination envelope is intact' },
  ]);
});

test('v2: a database with no feishu row at all is fine too (a fresh install, or one that has never probed)', () => {
  const d = legacyDb();
  assert.equal(applyMigrations(d, MIGRATIONS), latestMigrationVersion(MIGRATIONS));
  assert.equal((d.prepare('SELECT count(*) AS n FROM contract_probe').get() as { n: number }).n, 0);
});
