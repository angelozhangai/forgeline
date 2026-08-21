// 离线补拉（**provider 无关**）：IM 长连接断开期间（电脑关机/休眠/网络抖动）发的群消息不会在重连后补推，
// 于是开机/重连/周期三处主动拉群历史，把游标以后的需求文档链接补登记。
// 群聊历史本身就是「队列」：chat_cursor 记我们处理到哪条水位，addPrd 按文档去重，重复补拉无害。
//
// 为什么这段留在核心、只有那一次 API 往返在 adapter：这里的每一行都是「离线不漏需求」的正确性逻辑
// ——水位只前进、边界那条再过滤一次、防重入、抽链接的兜底顺序。它跟用哪个 IM 无关。换 Slack 时
// 只需 slack adapter 实现 listHistorySince（conversations.history），本文件一行不动。
import { log } from '../util/log.ts';
import { extractFeishuLinks } from '../util/links.ts';
import { addPrd } from '../intake.ts';
import * as cursors from '../store/cursors.ts';
import { port } from './index.ts';
import type { InboundMessage } from './model.ts';

// 一条历史消息里的需求文档链接：先扫正文，空则逐个扫 adapter 给的兜底文本块
// （文档分享卡 / 富文本 post 的链接不在正文里）。与 live 消息入口 handleMessage 同序，避免两条路径漂移。
function linksIn(m: InboundMessage): string[] {
  const fromText = extractFeishuLinks(m.text);
  if (fromText.length) return fromText;
  for (const st of m.searchTexts ?? []) {
    const found = extractFeishuLinks(st);
    if (found.length) return found;
  }
  return [];
}

// 补拉单群：游标以后的消息抽文档链接 → addPrd（按文档去重）。返回新登记条数。
export async function backfillChat(chatId: string): Promise<number> {
  const cursorMs = cursors.getCursor(chatId) ?? Date.now();
  const msgs = await port.listHistorySince(chatId, cursorMs);
  let maxTs = cursorMs;
  let n = 0;
  for (const m of msgs) {
    const ts = m.createTime;
    // adapter 的时间过滤可能是秒级精度（飞书 start_time 就是秒），边界那条会重复返回 → 核心按毫秒再滤一次。
    if (ts <= cursorMs) continue;
    // 注意（对应设计文档 D1）：这里**不**做 live 群消息那道「必须 @机器人」的入口闸。
    // 今天的补拉本就没有这道闸，Phase 0 是纯内部重构，绝不顺手改行为——历史条目是否带服务端 mentions
    // 需要在真实租户上验过才能统一（验不过就等于补拉静默失效）。统一与否走单独的 follow-up。
    for (const url of linksIn(m)) {
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

// 补拉所有已知群：adapter 报的观察群先种子化（首次从 now 起，不拉古早历史），再逐群补拉。
export async function backfillAll(): Promise<number> {
  if (backfilling) return 0;
  backfilling = true;
  try {
    for (const c of port.watchedChats()) cursors.seedCursor(c, Date.now());
    let total = 0;
    for (const c of cursors.allChats()) total += await backfillChat(c);
    if (total > 0) log.ok(`补拉完成：共新登记 ${total} 条离线期间需求`);
    return total;
  } finally {
    backfilling = false;
  }
}
