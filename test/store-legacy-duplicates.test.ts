// Integration: a **pre-existing older database** (the column names from before the rename, plus duplicate doc
// tokens) is migrated to the new shape at start-up without ever blocking the service.
// Three product goals: (1) the service starts (duplicate values must not drag the migration down); (2) a
// duplicate PRD still reuses the earliest session; (3) once the old data is cleaned up, the unique index is
// created automatically. This is the only place the upgrade path can be verified automatically - a real user's
// database looks exactly like this.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(resolve(tmpdir(), 'forge-legacy-db-'));
const dbPath = resolve(dir, 'service.db');
process.env.FORGE_DB = dbPath;

const here = dirname(fileURLToPath(import.meta.url));
// Rename three columns in the current schema **back to their pre-rename names**, producing a genuinely old
// database shape (with user_version left at 0).
// It replaces only those three definition lines in the session table (matching the alignment spacing, so it
// cannot accidentally hit chat_cursor's chat_id primary key).
const schema = readFileSync(resolve(here, '..', 'src', 'store', 'schema.sql'), 'utf8')
  .replace('  chat_id              TEXT,', '  feishu_chat_id       TEXT,')
  .replace(/ {2}doc_ref {14}TEXT,.*\n/, '  feishu_doc_token     TEXT,\n')
  .replace('  poster_id            TEXT,', '  poster_open_id       TEXT,');
for (const legacyCol of ['feishu_chat_id', 'feishu_doc_token', 'poster_open_id']) {
  if (!schema.includes(legacyCol)) throw new Error(`the fixture did not produce the old database shape: ${legacyCol} is missing (did the column alignment in schema.sql change?)`);
}
const legacy = new DatabaseSync(dbPath);
legacy.exec(schema);
const now = Date.now();
// Two rows sharing a **token** (left over from the exact-URL deduplication era): after the migration they
// become two rows with the same doc_ref, so the unique index cannot be created.
legacy.prepare(
  `INSERT INTO session (id, ref_num, slug, title, state, branch, prd_url, feishu_doc_token, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
).run('old-a', 1, 'old-a', 'old requirement A', 'INTAKE', 'dev', 'https://x.feishu.cn/docx/DUP?a=1', 'DUP', now - 1000, now - 1000);
legacy.prepare(
  `INSERT INTO session (id, ref_num, slug, title, state, branch, prd_url, feishu_doc_token, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
).run('old-b', 2, 'old-b', 'old requirement B', 'INTAKE', 'dev', 'https://x.feishu.cn/docx/DUP?a=2', 'DUP', now, now);
assert.equal((legacy.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 0);
legacy.close();

const sessions = await import('../src/store/sessions.ts');
const { latestMigrationVersion, MIGRATIONS } = await import('../src/store/db.ts');

test('an older database with duplicate doc tokens: the v1 migration still completes (renaming the columns and adding the source prefix) and the service starts', async () => {
  // The first listAll triggers db(), which runs v1. Duplicate values only prevent the unique index from being
  // created; they must never roll the migration back.
  const all = await sessions.listAll();
  assert.equal(all.filter((s) => s.doc_ref === 'feishu:DUP').length, 2, 'both rows should be renamed and given the feishu: prefix');
  assert.equal(all.filter((s) => s.chat_id === null).length, 2, 'after the rename the old values are still readable under the new name (here they were NULL to begin with)');
});

test('the logic layer still covers deduplication: a duplicate PRD reuses the earliest row, and another can still be inserted (confirming the unique index really was not created)', async () => {
  assert.equal((await sessions.findByDocRef('feishu:DUP'))?.id, 'old-a');
  await assert.doesNotReject(() => {
    return sessions.create({ id: 'old-c', slug: 'old-c', title: 'old requirement C', branch: 'dev', doc_ref: 'feishu:DUP' });
  });
  assert.equal((await sessions.findByDocRef('feishu:DUP'))?.id, 'old-a');
});

test('the migration removed the old unique index cleanly (the column was renamed, so leaving it would certainly break)', () => {
  const d = new DatabaseSync(dbPath);
  try {
    const names = (d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all() as { name: string }[]).map((r) => r.name);
    assert.ok(!names.includes('idx_session_doc_token'), 'the old index should have been dropped');
    assert.ok(!names.includes('idx_session_doc_ref'), 'the duplicate values are still present, so the new unique index should not have been created this time (it awaits manual cleanup)');
    // The version is pushed to the latest (migrations are a forward-only ratchet; exactly which number that is
    // MIGRATIONS decides, so do not hardcode it here).
    assert.equal((d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, latestMigrationVersion(MIGRATIONS));
  } finally {
    d.close();
  }
});

