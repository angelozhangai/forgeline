// 版本化迁移器（applyMigrations）：按 user_version 单调前进、逐条独立事务、失败回滚停在上一个好版本。
// 直接对内存 DatabaseSync 跑合成迁移，不碰真库——验机制本身，不镜像内部分支。
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

test('全新库(user_version=0)按 v 升序应用全部迁移并 bump 版本(传入乱序也按序)', () => {
  const d = new DatabaseSync(':memory:');
  const v = applyMigrations(d, [
    { v: 2, sql: 'CREATE TABLE b(x);' }, // 乱序传入
    { v: 1, sql: 'CREATE TABLE a(x);' },
  ]);
  assert.equal(v, 2);
  assert.equal(uv(d), 2);
  assert.deepEqual(tables(d), ['a', 'b']);
});

test('已是最新版(user_version≥max)→ 全跳过、无副作用(重复跑同列表不重放)', () => {
  const d = new DatabaseSync(':memory:');
  applyMigrations(d, [{ v: 1, sql: 'CREATE TABLE a(x);' }]);
  // 再跑同一条：v1<=cur(1) 跳过；若没跳过会因表 a 已存在而抛
  const v = applyMigrations(d, [{ v: 1, sql: 'CREATE TABLE a(x);' }]);
  assert.equal(v, 1);
  assert.equal(uv(d), 1);
});

test('只应用 v>当前 的迁移(增量前进，不重放已过的)', () => {
  const d = new DatabaseSync(':memory:');
  applyMigrations(d, [{ v: 1, sql: 'CREATE TABLE a(x);' }]); // → v1
  const v = applyMigrations(d, [
    { v: 1, sql: 'CREATE TABLE a(x);' }, // 跳过（已 ≤1），否则重复建 a 会抛
    { v: 2, sql: 'CREATE TABLE b(x);' }, // 应用
  ]);
  assert.equal(v, 2);
  assert.equal(uv(d), 2);
  assert.deepEqual(tables(d), ['a', 'b']);
});

test('迁移失败 → 回滚、抛错、版本停在上一个好版本(forward-only 安全)', () => {
  const d = new DatabaseSync(':memory:');
  assert.throws(
    () =>
      applyMigrations(d, [
        { v: 1, sql: 'CREATE TABLE a(x);' }, // 成功 → v1（独立事务，已落盘）
        { v: 2, sql: 'THIS IS NOT VALID SQL;' }, // 失败 → 回滚，停 v1
      ]),
    /迁移 v2 失败/,
  );
  assert.equal(uv(d), 1); // v1 已落、v2 没污染版本
  assert.deepEqual(tables(d), ['a']); // 只有 v1 的表，v2 的回滚干净
});

test('生产 MIGRATIONS 良构：v 单调递增且无重复(防手滑乱编号)', () => {
  const vs = MIGRATIONS.map((m) => m.v);
  assert.deepEqual(vs, [...vs].sort((a, b) => a - b)); // 升序
  assert.equal(new Set(vs).size, vs.length); // 无重复
});

test('latestMigrationVersion：空表→0；否则取最大 v（新库直接盖这个版本号，跳过历史迁移）', () => {
  assert.equal(latestMigrationVersion([]), 0);
  assert.equal(latestMigrationVersion([{ v: 3, sql: '' }, { v: 1, sql: '' }]), 3);
  assert.equal(latestMigrationVersion(MIGRATIONS), Math.max(...MIGRATIONS.map((m) => m.v)));
});

// ── v1：飞书列名 → provider 无关列名 + doc token 升级成带源前缀的 ref ──
// 对**存量老库形状**的固定装置跑真的 MIGRATIONS，这是升级路径唯一能被自动验证的地方。
// 用旧列名手搓一张最小 session 表（迁移只碰这三列 + 那个索引）。
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
  return d;
}
const cols = (d: DatabaseSync): string[] =>
  (d.prepare("SELECT name FROM pragma_table_info('session') ORDER BY name").all() as { name: string }[]).map((r) => r.name);
const indexes = (d: DatabaseSync): string[] =>
  (d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

test('v1：三列一次改名，存量 doc token 全部补上 feishu: 前缀', () => {
  const d = legacyDb();
  d.prepare('INSERT INTO session (id, feishu_chat_id, feishu_doc_token, poster_open_id) VALUES (?,?,?,?)').run('s1', 'oc_1', 'TOKA', 'ou_pm');
  d.prepare('INSERT INTO session (id, feishu_doc_token) VALUES (?,?)').run('s2', 'TOKB');
  d.prepare('INSERT INTO session (id, feishu_doc_token) VALUES (?,?)').run('s3', null); // 手动 add：本就没有文档

  assert.equal(applyMigrations(d, MIGRATIONS), latestMigrationVersion(MIGRATIONS));

  const names = cols(d);
  for (const c of ['chat_id', 'doc_ref', 'poster_id']) assert.ok(names.includes(c), `缺列 ${c}`);
  for (const c of ['feishu_chat_id', 'feishu_doc_token', 'poster_open_id']) assert.ok(!names.includes(c), `旧列 ${c} 还在`);

  // node:sqlite 返回 null 原型对象，deepStrictEqual 会因原型不同而失败 → 摊平成普通对象再比。
  const rows = (d.prepare('SELECT id, chat_id, doc_ref, poster_id FROM session ORDER BY id').all() as Record<string, unknown>[]).map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { id: 's1', chat_id: 'oc_1', doc_ref: 'feishu:TOKA', poster_id: 'ou_pm' },
    { id: 's2', chat_id: null, doc_ref: 'feishu:TOKB', poster_id: null },
    { id: 's3', chat_id: null, doc_ref: null, poster_id: null }, // NULL 不该被拼成 'feishu:null'
  ]);
});

test('v1：旧的 doc token 唯一索引被摘掉（列已不在，留着必然坏）', () => {
  const d = legacyDb();
  applyMigrations(d, MIGRATIONS);
  assert.ok(!indexes(d).includes('idx_session_doc_token'));
});

test('v1：重复跑不会把前缀叠加两次（user_version 保证只跑一次）', () => {
  const d = legacyDb();
  d.prepare('INSERT INTO session (id, feishu_doc_token) VALUES (?,?)').run('s1', 'TOKA');
  applyMigrations(d, MIGRATIONS);
  applyMigrations(d, MIGRATIONS); // 再跑一遍
  assert.equal((d.prepare('SELECT doc_ref FROM session WHERE id = ?').get('s1') as { doc_ref: string }).doc_ref, 'feishu:TOKA');
});

test('v1：升级后仍能按 doc_ref 去重——两条相同 ref 的行会被唯一索引挡住', () => {
  const d = legacyDb();
  d.prepare('INSERT INTO session (id, feishu_doc_token) VALUES (?,?)').run('s1', 'TOKA');
  applyMigrations(d, MIGRATIONS);
  // 迁移只负责摘旧索引；新索引由 db() 的 ensurePartialUniqueIndexes 建（旧库有重复值时不能拖崩迁移）。
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_session_doc_ref ON session(doc_ref) WHERE doc_ref IS NOT NULL;');
  assert.throws(
    () => d.prepare('INSERT INTO session (id, doc_ref) VALUES (?,?)').run('s2', 'feishu:TOKA'),
    /UNIQUE constraint failed/,
  );
  // 无文档的行不受约束（部分索引）：手动 add 可以有很多条
  d.prepare('INSERT INTO session (id, doc_ref) VALUES (?,?)').run('m1', null);
  d.prepare('INSERT INTO session (id, doc_ref) VALUES (?,?)').run('m2', null);
});
