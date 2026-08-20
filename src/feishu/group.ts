// 群里发/改卡片：回复 PM 那条消息发状态卡、之后原地编辑同一张卡、或直接发到群。
// 复用 bot tenant token（dm.ts），REST 直调（与 dm.ts 同风格）。
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
      log.warn(`群消息 ${method} 失败：${j.code} ${(j.msg ?? '').slice(0, 120)}`);
      return { ok: false };
    }
    return { ok: true, messageId: j.data?.message_id };
  } catch (e) {
    log.warn(`群消息 ${method} 异常：${String(e).slice(0, 120)}`);
    return { ok: false };
  }
}

// 回复某条消息（在它下面）发一张卡，返回新卡 message_id。
export async function replyCard(messageId: string, card: unknown): Promise<string | null> {
  const r = await call('POST', `${FEISHU_BASE}/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
    msg_type: 'interactive',
    content: JSON.stringify(card),
  });
  return r.messageId ?? null;
}

// 原地编辑已发卡片（同一张卡更新状态）。
export async function patchCard(messageId: string, card: unknown): Promise<boolean> {
  const r = await call('PATCH', `${FEISHU_BASE}/im/v1/messages/${encodeURIComponent(messageId)}`, {
    content: JSON.stringify(card),
  });
  return r.ok;
}

// 直接发卡到某群（无可回复源消息时，如手动 add）。
export async function sendCardToChat(chatId: string, card: unknown): Promise<string | null> {
  const r = await call('POST', `${FEISHU_BASE}/im/v1/messages?receive_id_type=chat_id`, {
    receive_id: chatId,
    msg_type: 'interactive',
    content: JSON.stringify(card),
  });
  return r.messageId ?? null;
}
