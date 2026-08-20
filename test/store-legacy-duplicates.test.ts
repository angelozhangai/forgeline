// 集成：旧库里若已有重复 feishu_doc_token，迁移不得阻断服务启动。
// 产品目标：服务能启动，重复 PRD 仍复用最早 session；清理旧数据后唯一索引再自动建上。
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
const schema = readFileSync(resolve(here, '..', 'src', 'store', 'schema.sql'), 'utf8');
const legacy = new DatabaseSync(dbPath);
legacy.exec(schema);
const now = Date.now();
legacy.prepare(
  `INSERT INTO session (id, ref_num, slug, title, state, branch, prd_url, feishu_doc_token, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
).run('old-a', 1, 'old-a', '旧需求 A', 'INTAKE', 'dev', 'https://x.feishu.cn/docx/DUP?a=1', 'DUP', now - 1000, now - 1000);
legacy.prepare(
  `INSERT INTO session (id, ref_num, slug, title, state, branch, prd_url, feishu_doc_token, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
).run('old-b', 2, 'old-b', '旧需求 B', 'INTAKE', 'dev', 'https://x.feishu.cn/docx/DUP?a=2', 'DUP', now, now);
legacy.close();

const sessions = await import('../src/store/sessions.ts');

test('旧库重复 doc token：服务可启动，逻辑去重复用最早 session，启动迁移不创建坏索引', async () => {
  assert.equal((await sessions.listAll()).filter((s) => s.feishu_doc_token === 'DUP').length, 2);
  assert.equal((await sessions.findByDocToken('DUP'))?.id, 'old-a');

  await assert.doesNotReject(() => {
    return sessions.create({ id: 'old-c', slug: 'old-c', title: '旧需求 C', branch: 'dev', feishu_doc_token: 'DUP' });
  });
  assert.equal((await sessions.findByDocToken('DUP'))?.id, 'old-a');
});

