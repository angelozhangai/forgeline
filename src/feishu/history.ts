// 飞书 provider 层——**群历史拉取**（im/v1/messages）。这里只剩「一次 API 往返 + 分页」，
// 补拉的业务循环（游标水位 / 抽链接 / 登记需求 / 防重入）已上移到 provider 无关的
// [messaging/backfill.ts](../messaging/backfill.ts)：换 IM 只换本文件的对等实现，那段
// 「离线不漏需求」的正确性逻辑一行不动。
//
// 只被 messaging/feishu.ts（唯一 adapter）调用——核心层直连本文件会被架构边界闸拦下。
import { log } from '../util/log.ts';
import { botTenantToken, FEISHU_BASE } from './dm.ts';

// im/v1/messages 的历史条目（只声明我们真读的字段）。
export interface FeishuHistMsg {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  sender?: { id?: string; id_type?: string };
  chat_id?: string;
  // 会话类型（'group' / 'p2p'）。live 事件的 message.chat_type 一定有；**历史条目不一定**——
  // 带就用，不带就回落到 chatIsGroup() 现问一次（见下）。
  chat_type?: string;
  body?: { content?: string };
  // 服务端填充的 @ 列表。live 事件里一定有；历史条目是否带取决于飞书信封——
  // 缺失与「真的没人被 @」不可区分，故 adapter 映射时用 undefined/[] 区分（见 messaging/feishu.ts）。
  mentions?: { id?: { open_id?: string }; id_type?: string; name?: string }[];
}
interface ListResp {
  code?: number;
  msg?: string;
  data?: { items?: FeishuHistMsg[]; has_more?: boolean; page_token?: string };
}

// 拉某群从 startSec(秒) 起的历史，按时间升序分页（上限 20 页 = 1000 条，防失控）。
// best-effort：鉴权/网络/接口报错一律返回**已拿到的部分** + warn，绝不抛（补拉不该拖垮周期循环）。
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
      log.warn(`补拉群历史网络异常（${chatId}）：${String(e).slice(0, 120)}`);
      return out;
    }
    if (j.code !== 0) {
      log.warn(`补拉群历史失败（${chatId}）：${j.code} ${(j.msg ?? '').slice(0, 140)}`);
      return out; // 权限/错误 → 返回已得，不抛
    }
    out.push(...(j.data?.items ?? []));
    // 契约守卫（廉价）：has_more=true 但没给 page_token = 分页信封漂移，会让我们静默早停、漏补消息。
    // backfill 是 best-effort，不停泊，只 warn 留痕（真探测由 probeFeishu/每日契约检查负责）。
    if (j.data?.has_more && !j.data?.page_token) {
      log.warn(`FEISHU_PAGINATION_DRIFT：has_more=true 但无 page_token（疑似 im/v1/messages 分页 schema 变更），${chatId} 本轮提前结束`);
    }
    if (!j.data?.has_more || !j.data?.page_token) break;
    pageToken = j.data.page_token;
  }
  return out;
}


// ── 这个会话是群还是私聊 ────────────────────────────────────────────
// 补拉必须知道这件事：把私聊历史当成群消息，会撞上「群里没 @ 我」的入口闸被丢掉——
// 离线期间私聊过来的需求就此静默消失，而那正是补拉存在的唯一理由。
//
// ⚠️ 用 **chat_mode**，不是 chat_type。同一个名字在飞书两个接口里意思不一样：
//   · 事件 message.chat_type：'group' / 'p2p'   ← 会话形态
//   · im/v1/chats 的 chat_type：'private' / 'public' ← 群的**可见性**
// 拿后者当前者用，所有公开群都会被判成私聊，入口闸整个失效。
//
// 会话形态一辈子不变 → 按 chatId 记忆，一个进程一次往返。拿不到就返回 null，由调用方决定怎么办
// （绝不猜一个，猜错的两个方向代价完全不对称）。
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
    log.warn(`取会话类型网络异常（${chatId}）：${String(e).slice(0, 120)}`);
    return null;
  }
  if (j.code !== 0 || typeof j.data?.chat_mode !== 'string') {
    log.warn(`取会话类型失败（${chatId}）：${j.code} ${(j.msg ?? '').slice(0, 120)}（需要 im:chat:readonly）`);
    return null;
  }
  const isGroup = j.data.chat_mode !== 'p2p';
  CHAT_IS_GROUP.set(chatId, isGroup);
  return isGroup;
}

/** 仅供测试：清掉会话类型记忆。 */
export function __clearChatKindCacheForTest(): void {
  CHAT_IS_GROUP.clear();
}
