// 集成：**存量老库**（Phase 1 之前的列名 + 重复 doc token）在启动时被迁移到新形状，且全程不阻断服务。
// 产品目标三条：① 服务能启动（重复值不能把迁移拖崩）；② 重复 PRD 仍复用最早 session；
// ③ 清理旧数据后唯一索引再自动建上。这是升级路径唯一能被自动验证的地方——真用户的库就长这样。
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
// 把当前 schema 的三列**改回 Phase 1 之前的名字**，造出真正的老库形状（user_version 留在 0）。
// 只替 session 表那三行的定义（带对齐空格，不会误伤 chat_cursor 的 chat_id 主键）。
const schema = readFileSync(resolve(here, '..', 'src', 'store', 'schema.sql'), 'utf8')
  .replace('  chat_id              TEXT,', '  feishu_chat_id       TEXT,')
  .replace(/ {2}doc_ref {14}TEXT,.*\n/, '  feishu_doc_token     TEXT,\n')
  .replace('  poster_id            TEXT,', '  poster_open_id       TEXT,');
for (const legacyCol of ['feishu_chat_id', 'feishu_doc_token', 'poster_open_id']) {
  if (!schema.includes(legacyCol)) throw new Error(`固定装置没造出老库形状：缺 ${legacyCol}（schema.sql 的列定义排版变了？）`);
}
const legacy = new DatabaseSync(dbPath);
legacy.exec(schema);
const now = Date.now();
// 两条**同 token**（精确-URL 去重时代的残留）：迁移后会变成两条同 doc_ref → 唯一索引建不上。
legacy.prepare(
  `INSERT INTO session (id, ref_num, slug, title, state, branch, prd_url, feishu_doc_token, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
).run('old-a', 1, 'old-a', '旧需求 A', 'INTAKE', 'dev', 'https://x.feishu.cn/docx/DUP?a=1', 'DUP', now - 1000, now - 1000);
legacy.prepare(
  `INSERT INTO session (id, ref_num, slug, title, state, branch, prd_url, feishu_doc_token, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
).run('old-b', 2, 'old-b', '旧需求 B', 'INTAKE', 'dev', 'https://x.feishu.cn/docx/DUP?a=2', 'DUP', now, now);
assert.equal((legacy.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 0);
legacy.close();

const sessions = await import('../src/store/sessions.ts');
const { latestMigrationVersion, MIGRATIONS } = await import('../src/store/db.ts');

test('存量老库有重复 doc token：v1 迁移照常完成（改名 + 补源前缀），服务可启动', async () => {
  // 第一次 listAll 触发 db() → 跑 v1。重复值只让唯一索引建不上，绝不能让迁移回滚。
  const all = await sessions.listAll();
  assert.equal(all.filter((s) => s.doc_ref === 'feishu:DUP').length, 2, '两条都应改名并补上 feishu: 前缀');
  assert.equal(all.filter((s) => s.chat_id === null).length, 2, '列改名后旧值仍能按新名读到（这里本就是 NULL）');
});

test('逻辑层去重仍然兜得住：重复 PRD 复用最早那条，且能再插进去（唯一索引确实没建）', async () => {
  assert.equal((await sessions.findByDocRef('feishu:DUP'))?.id, 'old-a');
  await assert.doesNotReject(() => {
    return sessions.create({ id: 'old-c', slug: 'old-c', title: '旧需求 C', branch: 'dev', doc_ref: 'feishu:DUP' });
  });
  assert.equal((await sessions.findByDocRef('feishu:DUP'))?.id, 'old-a');
});

test('迁移把旧唯一索引摘干净了（列已改名，留着必然坏）', () => {
  const d = new DatabaseSync(dbPath);
  try {
    const names = (d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all() as { name: string }[]).map((r) => r.name);
    assert.ok(!names.includes('idx_session_doc_token'), '旧索引应已 DROP');
    assert.ok(!names.includes('idx_session_doc_ref'), '存量重复值仍在 → 新唯一索引这次不该建上（待人工清理）');
    // 版本推到最新（迁移是 forward-only 的棘轮；具体到几由 MIGRATIONS 说了算，别在这儿写死数字）。
    assert.equal((d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, latestMigrationVersion(MIGRATIONS));
  } finally {
    d.close();
  }
});

