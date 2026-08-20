// 离线补拉：飞书长连接断开期间(电脑关机/休眠)发的群消息不会重连补推 →
// 开机/重连后主动拉群历史(im.v1.message.list)，把游标以后的飞书链接补登记。
// 群聊历史本身就是「队列」，chat_cursor 记我们处理到哪条；addPrd 按 URL 去重，重复无害。
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { botTenantToken, FEISHU_BASE } from './dm.ts';
import { extractFeishuLinks } from '../util/links.ts';
import { addPrd } from '../intake.ts';
import * as cursors from '../store/cursors.ts';

interface HistMsg {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  body?: { content?: string };
}
interface ListResp {
  code?: number;
  msg?: string;
  data?: { items?: HistMsg[]; has_more?: boolean; page_token?: string };
}

function toMs(t: string | undefined): number {
  const n = Number(t) || 0;
  return n > 0 && n < 1e12 ? n * 1000 : n; // 秒级兜底转毫秒
}

// 拉某群从 startSec(秒) 起的历史，按时间升序分页（上限 20 页 = 1000 条，防失控）。
async function listSince(chatId: string, startSec: number): Promise<HistMsg[]> {
  const token = await botTenantToken();
  if (!token) return [];
  const out: HistMsg[] = [];
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

// 补拉单群：游标以后的消息抽飞书链接 → addPrd（URL 去重）。返回新登记条数。
export async function backfillChat(chatId: string): Promise<number> {
  const cursorMs = cursors.getCursor(chatId) ?? Date.now();
  const msgs = await listSince(chatId, Math.floor(cursorMs / 1000));
  let maxTs = cursorMs;
  let n = 0;
  for (const m of msgs) {
    const ts = toMs(m.create_time);
    if (ts <= cursorMs) continue; // start_time 秒级边界内、已处理过的
    const content = m.body?.content ?? '';
    let links = extractFeishuLinks(content);
    if (links.length === 0) links = extractFeishuLinks(JSON.stringify(m));
    for (const url of links) {
      const r = await addPrd({ prdUrl: url, chatId });
      if (r.ok && r.session && r.created) {
        n++;
        log.ok(`补拉登记：${r.session.slug}（离线期间群消息）`);
      }
    }
    if (ts > maxTs) maxTs = ts;
  }
  cursors.advanceCursor(chatId, maxTs);
  return n;
}

let backfilling = false; // 防重入：开机/重连/周期三处都可能触发

// 补拉所有已知群：配置观察群先种子化(首次从 now 起，不拉古早历史)，再逐群补拉。
export async function backfillAll(): Promise<number> {
  if (backfilling) return 0;
  backfilling = true;
  try {
    const cfg = loadConfig();
    const watch = (cfg.env.FEISHU_WATCH_CHATS || cfg.env.FEISHU_REVIEW_CHAT_ID || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const c of watch) cursors.seedCursor(c, Date.now());
    let total = 0;
    for (const c of cursors.allChats()) total += await backfillChat(c);
    if (total > 0) log.ok(`补拉完成：共新登记 ${total} 条离线期间需求`);
    return total;
  } finally {
    backfilling = false;
  }
}
