// A single copy with no backup means the data is gone the moment it is lost. This uses node:sqlite's native
// online backup API (safe while the daemon holds the connection, so it needs no downtime and no sqlite3 CLI).
// The daemon's periodic loop throttles it to one backup an hour and keeps the most recent N.
import { backup, DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from './db.ts';
import { STATE_DIR, DB_PATH } from '../root.ts';
import { log } from '../util/log.ts';
import { hours } from '../util/time.ts';

const BACKUP_DIR = resolve(STATE_DIR, 'backups'); // state/ is already gitignored
const KEEP = 14;
const MIN_INTERVAL_MS = hours(1); // at most one backup per hour
let lastBackupMs = 0;

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function prune(): void {
  try {
    const files = readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('service-') && f.endsWith('.db'))
      .map((f) => ({ f, t: statSync(resolve(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(KEEP)) unlinkSync(resolve(BACKUP_DIR, f));
  } catch {
    /* pruning is best-effort */
  }
}

// Backup integrity verification: open the backup file on a read-only connection and run PRAGMA
// integrity_check, confirming it really opens and is not corrupt - otherwise the backup is written but never
// verified, and discovering it is broken at restore time is far too late. Exported for unit tests.
export function verifyBackup(dest: string): boolean {
  let conn: DatabaseSync | null = null;
  try {
    conn = new DatabaseSync(dest, { readOnly: true });
    const row = conn.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    return row?.integrity_check === 'ok';
  } catch {
    return false; // it will not open or fails to parse = a broken backup
  } finally {
    try {
      conn?.close();
    } catch {
      /* ignore */
    }
  }
}

// The hourly-throttled online backup. nowMs is supplied by the caller (the daemon passes Date.now()).
export async function maybeBackup(nowMs: number): Promise<void> {
  if (DB_PATH === ':memory:') return; // an in-memory test database is never backed up
  if (nowMs - lastBackupMs < MIN_INTERVAL_MS) return;
  lastBackupMs = nowMs;
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const dest = resolve(BACKUP_DIR, `service-${stamp(nowMs)}.db`);
    await backup(db(), dest);
    // Verify integrity immediately: a broken backup is deleted at once, so it neither takes a retention slot
    // from a good one nor silently leaves an unrecoverable file behind.
    if (!verifyBackup(dest)) {
      try {
        unlinkSync(dest);
      } catch {
        /* ignore */
      }
      log.warn(`⚠️ The backup failed its integrity check (integrity_check was not ok); the likely-corrupt ${dest.split('/').pop()} has been deleted and it will retry next cycle`);
      return;
    }
    prune();
    log.info(`🗄  Backed up service.db -> state/backups/${dest.split('/').pop()} (integrity ok)`);
  } catch (e) {
    log.warn(`The backup failed (this does not affect the main flow): ${String(e).slice(0, 160)}`);
  }
}
