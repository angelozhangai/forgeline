// Feishu provider layer — **chat history retrieval** (im/v1/messages). All that is left here is one API
// round trip plus pagination; backfill's business loop (cursor watermark / link extraction / requirement
// registration / re-entrancy guard) has moved up into the provider-neutral
// [messaging/backfill.ts](../messaging/backfill.ts): swapping IM means writing this file's equivalent,
// and the "never lose a requirement while offline" correctness logic does not change by a line.
//
// Called only by messaging/feishu.ts (the single adapter) — the architecture boundary gate blocks the
// core from importing this file directly.
import { log } from '../util/log.ts';
import { botTenantToken, FEISHU_BASE } from './dm.ts';

// A history entry from im/v1/messages (only the fields we actually read are declared).
export interface FeishuHistMsg {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  sender?: { id?: string; id_type?: string };
  chat_id?: string;
  // The conversation type ('group' / 'p2p'). A live event's message.chat_type is always present;
  // **a history entry's is not** — use it when present, otherwise fall back to asking chatIsGroup() once
  // (see below).
  chat_type?: string;
  body?: { content?: string };
  // The server-populated mention list. Always present on live events; whether a history entry carries it
  // depends on Feishu's envelope — a missing list is indistinguishable from "genuinely nobody was
  // mentioned", so the adapter distinguishes undefined from [] when mapping (see messaging/feishu.ts).
  mentions?: { id?: { open_id?: string }; id_type?: string; name?: string }[];
}
interface ListResp {
  code?: number;
  msg?: string;
  data?: { items?: FeishuHistMsg[]; has_more?: boolean; page_token?: string };
}

// Fetch a chat's history from startSec (seconds) onwards, paginated in ascending time order (capped at 20
// pages = 1000 entries, as a runaway guard).
// Best-effort: an auth, network or API error returns **whatever was already retrieved** plus a warning,
// and never throws (a backfill should not take the periodic loop down with it).
export async function listMessages(chatId: string, startSec: number): Promise<FeishuHistMsg[]> {
  const token = await botTenantToken();
  if (!token) return [];
  const out: FeishuHistMsg[] = [];
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${FEISHU_BASE}/im/v1/messages`);
    url.searchParams.set('container_id_type', 'chat');
    url.searchParams.set('container_id', chatId);
    url.searchParams.set('sort_type', 'ByCreateTimeAsc');
    url.searchParams.set('page_size', '50');
    if (startSec > 0) url.searchParams.set('start_time', String(startSec));
    if (pageToken) url.searchParams.set('page_token', pageToken);
    let j: ListResp;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      j = (await res.json()) as ListResp;
    } catch (e) {
      log.warn(`Network error while backfilling chat history (${chatId}): ${String(e).slice(0, 120)}`);
      return out;
    }
    if (j.code !== 0) {
      log.warn(`Backfilling chat history failed (${chatId}): ${j.code} ${(j.msg ?? '').slice(0, 140)}`);
      return out; // permissions or an error -> return what we have, do not throw
    }
    out.push(...(j.data?.items ?? []));
    // A cheap contract guard: has_more=true with no page_token means the pagination envelope has drifted,
    // which would make us stop early in silence and miss messages.
    // Backfill is best-effort and does not park, so this only warns to leave a trace (real detection is
    // probeFeishu's and the daily contract check's job).
    if (j.data?.has_more && !j.data?.page_token) {
      log.warn(`FEISHU_PAGINATION_DRIFT: has_more=true but no page_token (im/v1/messages' pagination schema may have changed); ${chatId} ends this round early`);
    }
    if (!j.data?.has_more || !j.data?.page_token) break;
    pageToken = j.data.page_token;
  }
  return out;
}


// -- Is this conversation a channel or a DM ----------------------------------
// Backfill has to know: treating DM history as channel messages makes them hit the "nobody @-mentioned
// me" intake gate and be dropped — requirements sent by DM while offline silently vanish, and that is the
// sole reason backfill exists.
//
// Warning: use **chat_mode**, not chat_type. The same name means different things in two Feishu APIs:
//   · an event's message.chat_type: 'group' / 'p2p'      <- the conversation's shape
//   · im/v1/chats's chat_type:      'private' / 'public' <- a group's **visibility**
// Using the latter as the former judges every public group a DM and disables the intake gate entirely.
//
// A conversation's shape never changes -> memoise by chatId, one round trip per process. When it cannot
// be obtained, return null and let the caller decide (never guess: the two directions of a wrong guess
// have completely asymmetric costs).
const CHAT_IS_GROUP = new Map<string, boolean>();

interface ChatResp {
  code?: number;
  msg?: string;
  data?: { chat_mode?: string };
}

export async function chatIsGroup(chatId: string): Promise<boolean | null> {
  const hit = CHAT_IS_GROUP.get(chatId);
  if (hit !== undefined) return hit;
  const token = await botTenantToken();
  if (!token) return null;
  let j: ChatResp;
  try {
    const res = await fetch(`${FEISHU_BASE}/im/v1/chats/${encodeURIComponent(chatId)}`, { headers: { Authorization: `Bearer ${token}` } });
    j = (await res.json()) as ChatResp;
  } catch (e) {
    log.warn(`Network error while fetching the conversation type (${chatId}): ${String(e).slice(0, 120)}`);
    return null;
  }
  if (j.code !== 0 || typeof j.data?.chat_mode !== 'string') {
    log.warn(`Fetching the conversation type failed (${chatId}): ${j.code} ${(j.msg ?? '').slice(0, 120)} (requires im:chat:readonly)`);
    return null;
  }
  const isGroup = j.data.chat_mode !== 'p2p';
  CHAT_IS_GROUP.set(chatId, isGroup);
  return isGroup;
}

/** Test-only: clear the memoised conversation types. */
export function __clearChatKindCacheForTest(): void {
  CHAT_IS_GROUP.clear();
}
