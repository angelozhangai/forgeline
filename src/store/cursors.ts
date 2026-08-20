// 群消息补拉游标：记「每个群处理到哪条消息了」(create_time 毫秒水位)。
// 离线期间 PM 发的需求 = 群历史里 ts > 水位的消息，开机后 backfill 捞回。
import { db } from './db.ts';

export function getCursor(chatId: string): number | null {
  const row = db().prepare('SELECT last_ts FROM chat_cursor WHERE chat_id = ?').get(chatId) as
    | { last_ts: number }
    | undefined;
  return row ? Number(row.last_ts) : null;
}

// 仅在不存在时种子化（首装从 now 起 → 不补拉工具诞生前的古早历史）。
export function seedCursor(chatId: string, ts: number): void {
  if (getCursor(chatId) === null) {
    db().prepare('INSERT INTO chat_cursor(chat_id, last_ts) VALUES(?, ?)').run(chatId, ts);
  }
}

// 推进水位（只前进不后退）；顺带登记该群供 backfill 遍历。
export function advanceCursor(chatId: string, ts: number): void {
  const cur = getCursor(chatId);
  if (cur === null) {
    db().prepare('INSERT INTO chat_cursor(chat_id, last_ts) VALUES(?, ?)').run(chatId, ts);
  } else if (ts > cur) {
    db().prepare('UPDATE chat_cursor SET last_ts = ? WHERE chat_id = ?').run(ts, chatId);
  }
}

// 所有已知群（配置种子 + live 消息自学习到的）。
export function allChats(): string[] {
  const rows = db().prepare('SELECT chat_id FROM chat_cursor').all() as { chat_id: string }[];
  return rows.map((r) => r.chat_id);
}
