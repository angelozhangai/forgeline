// 备份完整性校验：verifyBackup 对正常 sqlite 文件 → true，对损坏/非 sqlite 文件 → false。
// 守「备份不只写、要可恢复」——integrity_check 是单机 DB 韧性的务实底线。
process.env.FORGE_DB = ':memory:'; // 隔离：本测试只验 verifyBackup，不碰真库

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyBackup } from '../src/store/backup.ts';

test('verifyBackup：正常 sqlite 文件（有表有数据）→ true', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'forge-bk-ok-')), 'service.db');
  const d = new DatabaseSync(p);
  d.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1),(2),(3);');
  d.close();
  assert.equal(verifyBackup(p), true);
});

test('verifyBackup：非 sqlite 的垃圾文件 → false（不误报为可恢复）', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'forge-bk-bad-')), 'service.db');
  writeFileSync(p, 'NOT A SQLITE FILE — corrupted backup '.repeat(64));
  assert.equal(verifyBackup(p), false);
});

test('verifyBackup：不存在的路径 → false（打不开即坏）', () => {
  assert.equal(verifyBackup(join(tmpdir(), 'forge-bk-nope', 'missing.db')), false);
});
