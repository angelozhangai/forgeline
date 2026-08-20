// 单点无备份 = 数据丢了就没了。用 node:sqlite 原生在线 backup API（daemon 持有连接时安全，
// 不必停服、不依赖 sqlite3 CLI）。daemon 周期循环里 throttle 到每小时一份，留最近 N 份。
import { backup, DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from './db.ts';
import { STATE_DIR, DB_PATH } from '../root.ts';
import { log } from '../util/log.ts';
import { hours } from '../util/time.ts';

const BACKUP_DIR = resolve(STATE_DIR, 'backups'); // state/ 已 gitignore
const KEEP = 14;
const MIN_INTERVAL_MS = hours(1); // 最多每小时一份
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
    /* prune 尽力而为 */
  }
}

// 备份完整性校验：用只读连接对备份文件跑 PRAGMA integrity_check，确认它真能打开、未损坏——
// 否则备份是「只写不验」，真要恢复时才发现是坏的就晚了。导出供单测。
export function verifyBackup(dest: string): boolean {
  let conn: DatabaseSync | null = null;
  try {
    conn = new DatabaseSync(dest, { readOnly: true });
    const row = conn.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    return row?.integrity_check === 'ok';
  } catch {
    return false; // 打不开/解析失败 = 坏备份
  } finally {
    try {
      conn?.close();
    } catch {
      /* ignore */
    }
  }
}

// throttle 到每小时一次的在线备份。nowMs 由调用方传入（daemon 用 Date.now()）。
export async function maybeBackup(nowMs: number): Promise<void> {
  if (DB_PATH === ':memory:') return; // 测试内存库不备份
  if (nowMs - lastBackupMs < MIN_INTERVAL_MS) return;
  lastBackupMs = nowMs;
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const dest = resolve(BACKUP_DIR, `service-${stamp(nowMs)}.db`);
    await backup(db(), dest);
    // 立即验完整性：坏备份当即删掉，不让它顶掉一份好备份的留存位（也不静默留个不可恢复的文件）。
    if (!verifyBackup(dest)) {
      try {
        unlinkSync(dest);
      } catch {
        /* ignore */
      }
      log.warn(`⚠️ 备份完整性校验失败（integrity_check≠ok），已删除疑似损坏的 ${dest.split('/').pop()}；下个周期重试`);
      return;
    }
    prune();
    log.info(`🗄  已备份 service.db → state/backups/${dest.split('/').pop()}（完整性 ok）`);
  } catch (e) {
    log.warn(`备份失败（不影响主流程）：${String(e).slice(0, 160)}`);
  }
}
