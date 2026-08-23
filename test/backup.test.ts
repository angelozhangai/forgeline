// Backup integrity verification: verifyBackup returns true for a healthy sqlite file and false for a corrupt
// or non-sqlite one.
// It holds the line that a backup must be recoverable, not merely written - integrity_check is the pragmatic
// floor for single-machine database resilience.
process.env.FORGE_DB = ':memory:'; // isolation: this test only exercises verifyBackup and never touches the real database

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyBackup } from '../src/store/backup.ts';

test('verifyBackup: a healthy sqlite file (with a table and rows) -> true', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'forge-bk-ok-')), 'service.db');
  const d = new DatabaseSync(p);
  d.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1),(2),(3);');
  d.close();
  assert.equal(verifyBackup(p), true);
});

test('verifyBackup: a junk file that is not sqlite -> false (never wrongly reported as recoverable)', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'forge-bk-bad-')), 'service.db');
  writeFileSync(p, 'NOT A SQLITE FILE — corrupted backup '.repeat(64));
  assert.equal(verifyBackup(p), false);
});

test('verifyBackup: a path that does not exist -> false (if it will not open, it is broken)', () => {
  assert.equal(verifyBackup(join(tmpdir(), 'forge-bk-nope', 'missing.db')), false);
});
