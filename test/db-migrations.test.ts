// 版本化迁移器（applyMigrations）：按 user_version 单调前进、逐条独立事务、失败回滚停在上一个好版本。
// 直接对内存 DatabaseSync 跑合成迁移，不碰真库——验机制本身，不镜像内部分支。
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, MIGRATIONS } from '../src/store/db.ts';

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
