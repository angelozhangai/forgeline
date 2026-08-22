// 传输层薄缝——**飞书 adapter**（MessagingPort 的唯一实现）。
// 出站：把 provider 无关的 CardModel 渲染成飞书 2.0 card JSON（renderFeishuCard）+ 经 feishu/* 收发。
// 入站：把飞书原始事件解析成 provider 无关的 InboundCardAction / InboundMessage。
//
// 设计：所有飞书 JSON 形状 + markdown 扩展语法（<font> 上色 / select_static / form / column_set / <at> @人）
// 都收敛在本文件。核心（notify/listen）只持有 CardModel 语义块，不碰任何飞书 tag。
// 唯一受控残留：少量散文块（text/note/footnote/quote）的 content 里可能带可移植的内联强调（如 <font>）——
// 这是「散文内容」而非「结构」，未来 Slack adapter 对散文块统一做 <font>→自家强调的转换即可。
import * as lark from '@larksuiteoapi/node-sdk';
import { sendBotCardObject, sendBotCard, botTenantToken, botOpenId, botOpenIdCached, FEISHU_BASE } from '../feishu/dm.ts';
import { listMessages, type FeishuHistMsg } from '../feishu/history.ts';
import { replyCard, patchCard, sendCardToChat } from '../feishu/group.ts';
import { postCard } from '../feishu/notify.ts';
import { petImageKey } from '../feishu/petAssets.ts';
import { FUN_ON } from '../util/pet.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { answerableDecisions, DECISION_CAP, type DecisionItem } from '../gates/envelopes.ts';
import type { CardModel, CardBlock, CardButton, CardColor, CalloutTone, FindingLine, InboundCardAction, InboundMessage } from './model.ts';
import type { MessagingPort, InboundHandlers, InboundChannel, InboundProbe } from './port.ts';

// 像素宠物动图开关：默认开，但仅当 keys.json 里有对应 image_key 才真挂图（否则回退纯文字/emoji）。FORGE_PET_GIF=0 强制关。
const PET_GIF_ON = FUN_ON && process.env.FORGE_PET_GIF !== '0';

// 鉴权失效时给操作者的处置指引（随探针结果上浮到告警里）。怎么修是 provider 知识，核心不替它说话。
const FEISHU_AUTH_FIX = '检查飞书 bot 凭据/权限（FEISHU_BOT_APP_ID/SECRET、群是否已加 bot）';

// ── 飞书 2.0 元素原语（从 notify.ts 原样迁来，保字节级不变）──────────────
const md = (content: string): Record<string, unknown> => ({ tag: 'markdown', content });
const hr = { tag: 'hr' };
const grey = (t: string): Record<string, unknown> => md(`<font color='grey'>${t}</font>`);
// 小字灰脚注：card 2.0 已废弃 note 块，改用 markdown 的 text_size:notation（小一号字）+ 灰色。
const small = (content: string): Record<string, unknown> => ({ tag: 'markdown', text_size: 'notation', content: `<font color='grey'>${content}</font>` });
// 引用块：markdown 的 `>`，把「概述」做成低存在感的引述。
const quote = (text: string): Record<string, unknown> => md(`> ${text.replace(/\s*\n\s*/g, ' ').trim()}`);
const field = (t: string): Record<string, unknown> => ({ tag: 'column', width: 'weighted', weight: 1, elements: [md(t)] });
const cbBtn = (text: string, type: string, action: string, slug: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag: 'button',
  text: { tag: 'plain_text', content: text },
  type,
  behaviors: [{ type: 'callback', value: { action, slug, ...extra } }],
});
const sevTag = (s?: string): string =>
  s === 'high' ? "<font color='red'>[high]</font>" : s === 'med' ? "<font color='orange'>[med]</font>" : "<font color='grey'>[low]</font>";
// callout 语义色调 → 飞书 markdown 颜色。
const CALLOUT_COLOR: Record<CalloutTone, string> = { danger: 'red', warning: 'orange', info: 'blue' };
const calloutEl = (tone: CalloutTone, content: string): Record<string, unknown> => md(`<font color='${CALLOUT_COLOR[tone]}'>${content}</font>`);

// 宠物头像 img 元素（56px 像素动图，圆角，居中裁切）。
function petImgEl(key: string): Record<string, unknown> {
  return { tag: 'img', img_key: key, alt: { tag: 'plain_text', content: '需求宠物' }, scale_type: 'crop_center', size: '56px 56px', corner_radius: '8px' };
}
// 「头像在左 + 文字在右」一行：有 image_key → column_set(头像|文字)；无图 → 只返回文字 md（优雅降级）。
function petRowEl(assetName: string, content: string): Record<string, unknown> {
  const text = md(content);
  const key = PET_GIF_ON ? petImageKey(assetName) : null;
  if (!key) return text;
  return {
    tag: 'column_set',
    columns: [
      { tag: 'column', width: 'auto', vertical_align: 'center', elements: [petImgEl(key)] },
      { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [text] },
    ],
  };
}

// 待决项逐条展示：问句 + 每个选项（★标推荐 + 影响副文案）+ 副提示。
const decisionItemsMd = (items: DecisionItem[]): unknown[] =>
  items.slice(0, DECISION_CAP).map((it, i) => {
    const opts = it.options
      .map((o) => `　- ${o.recommended ? '★ ' : ''}${o.label}${o.impact ? `（影响：${o.impact}）` : ''}`)
      .join('\n');
    return md(
      `**${i + 1}.** ${sevTag(it.severity)} ${it.prompt}` +
        (opts ? `\n${opts}` : '') +
        (it.hint ? `\n<font color='grey'>建议：${it.hint}</font>` : ''),
    );
  });

// 残留评审意见 / 开放问题逐条（severity 标签 + 位置/建议灰字副行）。
const findingItemsMd = (findings: FindingLine[]): unknown[] =>
  findings.map((f, i) =>
    md(`**${i + 1}.** ${sevTag(f.severity)} ${f.lead}${(f.notes ?? []).map((n) => `\n<font color='grey'>${n.label}：${n.text}</font>`).join('')}`),
  );

// 决策表单：每条有选项的待决项 → 一个下拉（★标推荐 + 「其他」兜底），末尾全局补充框 + 提交按钮。
// answerableDecisions 保证 select 的 name=ask_<id> 与 composeDecisionAnswer 回拼**同序对齐**（绝不串题）。
// verdict=true（闸A）加一个整体结论下拉。round 透传 → 防群卡原地编辑时第2轮提交被飞书去重吞掉。
const decisionFormEl = (
  slug: string,
  items: DecisionItem[],
  o: { action: string; round?: number; verdict?: boolean; submitText: string; notesLabel: string; notesPlaceholder: string },
): Record<string, unknown> => {
  const selects = answerableDecisions(items).map(({ id, item }) => ({
    tag: 'select_static',
    name: `ask_${id}`,
    placeholder: { tag: 'plain_text', content: `${id}：选择…` },
    options: [
      ...item.options.slice(0, 10).map((opt) => {
        const v = opt.label.slice(0, 120);
        return { text: { tag: 'plain_text', content: `${opt.recommended ? '★ ' : ''}${v}` }, value: v };
      }),
      { text: { tag: 'plain_text', content: '其他（在下方补充说明里填）' }, value: '__other__' },
    ],
  }));
  const verdictEl = o.verdict
    ? [
        {
          tag: 'select_static',
          name: 'verdict',
          placeholder: { tag: 'plain_text', content: '整体结论…' },
          options: [
            { text: { tag: 'plain_text', content: '✅ 采纳建议，确认通过' }, value: 'accept' },
            { text: { tag: 'plain_text', content: '📝 部分采纳（见逐条/补充）' }, value: 'partial' },
          ],
        },
      ]
    : [];
  return {
    tag: 'form',
    name: `${o.action}_form`,
    elements: [
      ...selects,
      ...verdictEl,
      { tag: 'input', name: 'notes', label: { tag: 'plain_text', content: o.notesLabel }, placeholder: { tag: 'plain_text', content: o.notesPlaceholder } },
      { tag: 'button', text: { tag: 'plain_text', content: o.submitText }, type: 'primary', form_action_type: 'submit', name: 'submit', behaviors: [{ type: 'callback', value: { action: o.action, round: o.round ?? 0, slug } }] },
    ],
  };
};

// 立项表单（私聊 M）：DRI 下拉（默认推荐人）+「立项·建需求」提交 → go 回调（form_value.assignee 带选定人）。
const goFormEl = (slug: string, pool: string[], picked: string | null): Record<string, unknown> => ({
  tag: 'form',
  name: 'go_form',
  elements: [
    {
      tag: 'select_static',
      name: 'assignee',
      placeholder: { tag: 'plain_text', content: '指派 DRI…' },
      ...(picked && pool.includes(picked) ? { initial_option: picked } : {}),
      options: pool.map((c) => ({ text: { tag: 'plain_text', content: c }, value: c })),
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '✅ 立项 · 建需求' },
      type: 'primary',
      form_action_type: 'submit',
      name: 'submit',
      behaviors: [{ type: 'callback', value: { action: 'go', slug } }],
    },
  ],
});

const btnEl = (b: CardButton): Record<string, unknown> => cbBtn(b.text, b.style, b.action, b.slug, b.value ?? {});

// CardBlock → 飞书 2.0 元素（一块可展开成 0..N 个元素，故返回数组，外层 flatMap）。
function renderBlock(b: CardBlock): unknown[] {
  switch (b.kind) {
    case 'text':
      return [md(b.md)];
    case 'note':
      return [grey(b.md)];
    case 'footnote':
      return [small(b.md)];
    case 'quote':
      return [quote(b.text)];
    case 'callout':
      return [calloutEl(b.tone, b.md)];
    case 'divider':
      return [hr];
    case 'stats':
      return [{ tag: 'column_set', columns: b.fields.map(field) }];
    case 'button':
      return [btnEl(b.button)];
    case 'buttonRow':
      return [{ tag: 'column_set', columns: b.buttons.map((btn) => ({ tag: 'column', width: 'weighted', weight: 1, elements: [btnEl(btn)] })) }];
    case 'decisionList':
      return decisionItemsMd(b.items);
    case 'findingList':
      return findingItemsMd(b.findings);
    case 'decisionForm':
      return [decisionFormEl(b.slug, b.items, { action: b.action, round: b.round, verdict: b.verdict, submitText: b.submitText, notesLabel: b.notesLabel, notesPlaceholder: b.notesPlaceholder })];
    case 'goForm':
      return [goFormEl(b.slug, b.pool, b.picked)];
    case 'petRow': {
      const content = b.mentionId ? `<at id=${b.mentionId}></at> ${b.voice}` : b.voice;
      return [petRowEl(b.asset, content)];
    }
  }
}

// CardModel → 飞书 2.0 card JSON。subtitle 仅在非空时出 key（与原 buildCard.card() 一致）。
export function renderFeishuCard(card: CardModel): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: card.color,
      title: { tag: 'plain_text', content: card.title },
      ...(card.subtitle ? { subtitle: { tag: 'plain_text', content: card.subtitle } } : {}),
    },
    body: { elements: card.blocks.flatMap(renderBlock) },
  };
}

// ── 入站：飞书原始事件 → provider 无关事件 ──────────────────────────────
// 从原始事件里挖表单值（confirm_form 的 verdict / notes / ask_* / assignee）。导出供单测直接覆盖。
export function formValue(evt: Record<string, unknown>): Record<string, string> {
  const raw = evt.raw as Record<string, unknown> | undefined;
  const ev = (raw?.event ?? raw) as Record<string, unknown> | undefined;
  const action = ev?.action as Record<string, unknown> | undefined;
  const fv = action?.form_value as Record<string, string> | undefined;
  return fv ?? {};
}

// 观察群列表（补拉遍历 + 契约探针取样共用同一份解析，避免两处各写一遍逗号切分而漂移）。
function watchChats(): string[] {
  const env = loadConfig().env;
  return (env.FEISHU_WATCH_CHATS || env.FEISHU_REVIEW_CHAT_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// 历史条目 → provider 无关 InboundMessage。与 parseMessage 保持同样的兜底口径：
// 正文取 body.content 里的 text，另附整条序列化文本块供核心兜底抽链接（分享卡/富文本的链接不在正文）。
function histToInbound(m: FeishuHistMsg, chatId: string): InboundMessage {
  let text = '';
  if (m.body?.content) {
    try {
      text = (JSON.parse(m.body.content) as { text?: string }).text ?? '';
    } catch {
      text = m.body.content;
    }
  }
  const n = Number(m.create_time) || 0;
  const createTime = n > 0 && n < 1e12 ? n * 1000 : n; // 飞书历史给秒级，live 事件给毫秒 → 统一成毫秒
  const botId = botOpenIdCached();
  // mentions 缺失（信封没这个字段）与「真的没人 @」不可区分 → 前者只能报 null（无法确认）。
  // 核心的补拉循环 Phase 0 不读这个字段（见 messaging/backfill.ts 里的 D1 说明），此处如实映射，
  // 让「历史条目到底带不带 mentions」在真实租户上一验即知，而不是靠猜。
  const mentionedBot = m.mentions === undefined || botId === null ? null : m.mentions.some((mn) => mn?.id?.open_id === botId);
  return {
    type: 'message',
    chatId: m.chat_id || chatId,
    senderId: m.sender?.id,
    messageId: m.message_id,
    text,
    searchTexts: [JSON.stringify(m)],
    createTime,
    isGroup: true, // 补拉只针对群/频道历史
    mentionedBot,
  };
}

const feishuPort: MessagingPort = {
  id: 'feishu',
  async sendDmCard(card) {
    return sendBotCardObject(renderFeishuCard(card));
  },
  async sendDmText(title, lines, color) {
    return sendBotCard(title, lines, color as CardColor);
  },
  async replyGroupCard(replyToMessageId, card) {
    return replyCard(replyToMessageId, renderFeishuCard(card));
  },
  async sendGroupCard(chatId, card) {
    return sendCardToChat(chatId, renderFeishuCard(card));
  },
  async editGroupCard(messageId, card) {
    return patchCard(messageId, renderFeishuCard(card));
  },
  async postWebhook(title, lines, color) {
    return postCard(title, lines, color as CardColor);
  },
  parseCardAction(raw: Record<string, unknown>): InboundCardAction | null {
    const action = raw.action as { value?: Record<string, unknown> } | undefined;
    const value = action?.value ?? {};
    const act = String(value.action ?? '');
    const slug = String(value.slug ?? '');
    if (!act || !slug) return null;
    const r = raw.raw as Record<string, unknown> | undefined;
    const ev = (r?.event ?? r) as Record<string, unknown> | undefined;
    const operator = ev?.operator as Record<string, unknown> | undefined;
    const operatorId = typeof operator?.open_id === 'string' ? operator.open_id : undefined;
    return { type: 'card_action', action: act, slug, value, formValues: formValue(raw), operatorId };
  },
  parseMessage(raw: Record<string, unknown>): InboundMessage | null {
    const r = raw.raw as Record<string, unknown> | undefined;
    const ev = r?.event as Record<string, unknown> | undefined;
    const msg = ev?.message as
      | { content?: string; chat_type?: string; mentions?: { id?: { open_id?: string } }[] }
      | undefined;
    const chatId = typeof raw.chatId === 'string' ? raw.chatId : '';
    const senderId = typeof raw.senderId === 'string' ? raw.senderId : undefined;
    const messageId = typeof raw.messageId === 'string' ? raw.messageId : undefined;
    // 缺/坏 createTime 兜 now()，**不**兜 0——否则 listen 推进 cursor 时会把该群水位插到 epoch，
    // 触发 backfill 从超早时间重扫历史、把旧 PRD 链接重新喂进入口（重复提醒/无谓 tick）。沿用旧链路语义。
    const createTime = Number(raw.createTime) || Date.now();
    let text = typeof raw.text === 'string' ? raw.text : '';
    if (!text && msg?.content) {
      try {
        text = (JSON.parse(msg.content) as { text?: string }).text ?? '';
      } catch {
        text = msg.content;
      }
    }
    // 链接常不在纯文本里（文档分享卡 / 富文本 post）——把整条事件序列化成一个不透明文本块兜底，
    // 由核心对 text + searchTexts 跑 extractFeishuLinks（保留原 `extractFeishuLinks(JSON.stringify(evt))` 兜底）。
    const searchTexts = [JSON.stringify(raw)];
    // 群消息入口闸的判定材料：是否群消息 + 本机器人是否被 @。
    // 读事件里**服务端填充的 mentions[].id.open_id**（任何消息类型都在，含文档分享/富文本 post——
    // 正是 SDK 正文 @ normalize 会漏、当初关掉 requireMention 的那类），跟 bot 自身 open_id 比对。
    // bot open_id 未就绪（未配 env 且 bot/v3/info 未预热）→ mentionedBot=null，核心保守忽略。
    const isGroup = msg?.chat_type === 'group';
    const botId = botOpenIdCached();
    const mentionedBot =
      botId === null
        ? null
        : (msg?.mentions ?? []).some((mn) => typeof mn?.id?.open_id === 'string' && mn.id.open_id === botId);
    return { type: 'message', chatId, senderId, messageId, text, searchTexts, createTime, isGroup, mentionedBot };
  },
  inboundConfigured(): boolean {
    const env = loadConfig().env;
    return !!(env.FEISHU_BOT_APP_ID && env.FEISHU_BOT_APP_SECRET);
  },
  startInbound(handlers: InboundHandlers): InboundChannel {
    // 飞书长连接 channel：构造 + 事件订阅 + 重连全收敛在 adapter（core 不碰 lark / channel 生命周期）。
    const env = loadConfig().env;
    const appId = env.FEISHU_BOT_APP_ID as string;
    const appSecret = env.FEISHU_BOT_APP_SECRET as string;
    const wsDebug = process.env.FORGE_WS_DEBUG === '1';
    // 预热 bot 自身 open_id（群消息入口闸判 @ 用）——连上前先填好缓存，避免首条群消息撞到「身份未就绪」。
    void botOpenId();
    const channel = lark.createLarkChannel({
      appId,
      appSecret,
      includeRawEvent: true,
      loggerLevel: wsDebug ? lark.LoggerLevel.debug : lark.LoggerLevel.info,
      // 这里**不**让 SDK 按 @ 拦截：文档分享/富文本消息的 @ 常不被 SDK 正文 normalize 识别 → 会被静默拦掉。
      // 改由我们自己在 parseMessage/listen 读事件里**服务端填充的 mentions** 判 @（更可靠、覆盖分享卡），
      // 群消息「未 @机器人 不入流程」的闸落在 handleMessage（见 daemon/listen.ts）。
      policy: { requireMention: false },
    });
    channel.on('cardAction', (evt: unknown) => handlers.onCardAction(evt as Record<string, unknown>));
    channel.on('message', (evt: unknown) => handlers.onMessage(evt as Record<string, unknown>));
    channel.on('reject', (e: unknown) => log.warn(`消息被策略拦截：${JSON.stringify(e).slice(0, 200)}`));
    channel.on('error', (e: unknown) => handlers.onError(String(e)));
    channel.on('reconnected', () => handlers.onReconnected());
    return { connect: () => channel.connect() };
  },
  watchedChats(): string[] {
    return watchChats();
  },
  async listHistorySince(chatId: string, sinceMs: number): Promise<InboundMessage[]> {
    // 飞书 start_time 是**秒**级：向下取整可能把水位那一秒的消息带回来，核心按 createTime 毫秒再滤一次。
    const items = await listMessages(chatId, Math.floor(sinceMs / 1000));
    return items.map((m) => histToInbound(m, chatId));
  },
  async probe(): Promise<InboundProbe> {
    // 只读、page_size=1、无副作用：验的正是 listHistorySince 依赖的 im/v1/messages 分页信封。
    // 飞书 IM API 细节（base/token/分页字段）收敛在 adapter，不泄进 llm/health 层。
    const { env } = loadConfig();
    const chat = watchChats()[0];
    if (!env.FEISHU_BOT_APP_ID || !env.FEISHU_BOT_APP_SECRET || !chat) {
      return { available: false, ok: false, detail: '飞书 bot/观察群未配齐（跳过）' };
    }
    const token = await botTenantToken();
    if (!token) return { available: true, ok: false, kind: 'auth', detail: '取 tenant_access_token 失败（鉴权/网络，非必然漂移）', authFix: FEISHU_AUTH_FIX };
    try {
      const url = new URL(`${FEISHU_BASE}/im/v1/messages`);
      url.searchParams.set('container_id_type', 'chat');
      url.searchParams.set('container_id', chat);
      url.searchParams.set('page_size', '1');
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const j = (await res.json()) as { code?: number; msg?: string; data?: Record<string, unknown> };
      if (j.code !== 0) return { available: true, ok: false, kind: 'auth', detail: `im/v1/messages code=${j.code}（${(j.msg ?? '').slice(0, 80)}，可能权限/群未加 bot，非必然漂移）` };
      const d = j.data ?? {};
      const missing: string[] = [];
      if (!('items' in d) || !Array.isArray(d.items)) missing.push('data.items');
      if (!('has_more' in d)) missing.push('data.has_more');
      if (!('page_token' in d)) missing.push('data.page_token');
      return missing.length
        ? { available: true, ok: false, kind: 'drift', detail: `飞书 im/v1/messages 缺分页信封字段：${missing.join('、')}（疑似 API schema 变更）`, raw: JSON.stringify(j).slice(0, 800) }
        : { available: true, ok: true, detail: '飞书 im/v1/messages 分页信封完好' };
    } catch (e) {
      return { available: true, ok: false, kind: 'auth', detail: `飞书探针网络异常：${String(e).slice(0, 100)}` };
    }
  },
};

export { feishuPort };
