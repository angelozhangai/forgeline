// The group-message backfill cursor: it records "how far through each chat's messages we got" (a create_time
// watermark in milliseconds).
// A requirement the PM posted while the service was offline is a message in the chat history whose ts is above
// the watermark, and the backfill recovers it on start-up.
import { db } from './db.ts';

export function getCursor(chatId: string): number | null {
  const row = db().prepare('SELECT last_ts FROM chat_cursor WHERE chat_id = ?').get(chatId) as
    | { last_ts: number }
    | undefined;
  return row ? Number(row.last_ts) : null;
}

// Seed the cursor only when none exists (a first install starts from now, so it does not backfill ancient
// history from before the tool existed).
export function seedCursor(chatId: string, ts: number): void {
  if (getCursor(chatId) === null) {
    db().prepare('INSERT INTO chat_cursor(chat_id, last_ts) VALUES(?, ?)').run(chatId, ts);
  }
}

// Advance the watermark (forwards only, never backwards); this also registers the chat for the backfill to
// walk.
export function advanceCursor(chatId: string, ts: number): void {
  const cur = getCursor(chatId);
  if (cur === null) {
    db().prepare('INSERT INTO chat_cursor(chat_id, last_ts) VALUES(?, ?)').run(chatId, ts);
  } else if (ts > cur) {
    db().prepare('UPDATE chat_cursor SET last_ts = ? WHERE chat_id = ?').run(ts, chatId);
  }
}

// Every known chat (those seeded from config plus those learned from live messages).
export function allChats(): string[] {
  const rows = db().prepare('SELECT chat_id FROM chat_cursor').all() as { chat_id: string }[];
  return rows.map((r) => r.chat_id);
}
