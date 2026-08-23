// Posting and editing cards in a chat: reply to the PM's message with a status card, then edit that same
// card in place, or post straight to the chat.
// Reuses the bot tenant token (dm.ts) and calls REST directly (the same style as dm.ts).
import { botTenantToken, FEISHU_BASE } from './dm.ts';
import { log } from '../util/log.ts';

async function call(method: string, url: string, body: unknown): Promise<{ ok: boolean; messageId?: string }> {
  const token = await botTenantToken();
  if (!token) return { ok: false };
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = (await res.json()) as { code?: number; msg?: string; data?: { message_id?: string } };
    if (j.code !== 0) {
      log.warn(`Chat message ${method} failed: ${j.code} ${(j.msg ?? '').slice(0, 120)}`);
      return { ok: false };
    }
    return { ok: true, messageId: j.data?.message_id };
  } catch (e) {
    log.warn(`Chat message ${method} threw: ${String(e).slice(0, 120)}`);
    return { ok: false };
  }
}

// Reply to a message (underneath it) with a card; returns the new card's message_id.
export async function replyCard(messageId: string, card: unknown): Promise<string | null> {
  const r = await call('POST', `${FEISHU_BASE}/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
    msg_type: 'interactive',
    content: JSON.stringify(card),
  });
  return r.messageId ?? null;
}

// Edit an already-posted card in place (updating the status on the same card).
export async function patchCard(messageId: string, card: unknown): Promise<boolean> {
  const r = await call('PATCH', `${FEISHU_BASE}/im/v1/messages/${encodeURIComponent(messageId)}`, {
    content: JSON.stringify(card),
  });
  return r.ok;
}

// Post a card straight to a chat (when there is no source message to reply to, such as a manual add).
export async function sendCardToChat(chatId: string, card: unknown): Promise<string | null> {
  const r = await call('POST', `${FEISHU_BASE}/im/v1/messages?receive_id_type=chat_id`, {
    receive_id: chatId,
    msg_type: 'interactive',
    content: JSON.stringify(card),
  });
  return r.messageId ?? null;
}
