// 传输层薄缝——**Slack adapter**（MessagingPort 的第二个实现）。
// 出站：CardModel → Block Kit（+ attachment 上的颜色条）；入站：Slack 事件 → provider 无关事件。
//
// 所有 Slack 形状都收敛在本文件 + slack/*：mrkdwn 方言、Block Kit 块型、composite message id、
// 模态往返。核心（notify/listen/worker/actions）一行都没有为 Slack 改过——那正是这条缝的意义。
//
// 三处与飞书**必然**不同，且都被挡在这一层里：
//  · **表单**：Slack 的 input 块只在 modal 里合法 → 卡上放按钮 → views.open → 一条 view_submission
//    带回全部字段（见 slack/modal.ts）。InboundCardAction.formValues 的形状没变。
//  · **消息 id**：chat.update 要 channel + ts 两个值，而 editGroupCard(messageId,…) 只有一个 →
//    对外用不透明的 "channel:ts" 复合 id。核心从不解析 status_msg_id / intake_msg_id，安全。
//  · **颜色**：Block Kit 没有卡片主色 → 用 attachment.color 那道竖色条承载语义色。
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { slackApi } from '../slack/web.ts';
import { createSocketChannel } from '../slack/socket.ts';
import { buildDecisionModal, buildGoModal, parseViewSubmission, type ModalContext } from '../slack/modal.ts';
import { DECISION_CAP, type DecisionItem } from '../gates/envelopes.ts';
import type { CalloutTone, CardBlock, CardButton, CardColor, CardModel, FindingLine, InboundCardAction, InboundMessage } from './model.ts';
import type { InboundChannel, InboundHandlers, InboundProbe, MessagingPort } from './port.ts';

export const SLACK_PROVIDER_ID = 'slack';

// 语义色 → attachment 左侧色条。Slack 只吃 hex，没有模板色的概念。
const COLOR_HEX: Record<CardColor, string> = {
  red: '#e01e5a',
  blue: '#2f7ed8',
  green: '#2eb886',
  grey: '#868686',
  orange: '#e8912d',
};
// callout 语义色调 → emoji 前缀。Block Kit 的正文没有内联着色，emoji 是唯一可移植的强调手段。
const CALLOUT_PREFIX: Record<CalloutTone, string> = { danger: '🔴', warning: '🟠', info: '🔵' };
const SEV_PREFIX = (s?: string): string => (s === 'high' ? '🔴 [high]' : s === 'med' ? '🟠 [med]' : '⚪️ [low]');

// ── markdown → Slack mrkdwn ─────────────────────────────────────────
// 核心的散文块里带的是通用 markdown（外加飞书时代遗留的少量 <font>/<at>）。Slack 的方言不一样：
// 粗体是单星号、链接是 <url|text>、@人是 <@Uxxx>。这层转换是**内容级**的，不是结构级的——
// 结构（块型）由 renderBlock 决定，这里只管一段字符串怎么写。
export function toMrkdwn(src: string): string {
  return (
    (src ?? '')
      // 先摘掉飞书的内联标记：<font color='grey'>x</font> → x；<at id=ou_x></at> → <@ou_x>
      .replace(/<font\s+color=['"]?[\w-]+['"]?>([\s\S]*?)<\/font>/g, '$1')
      .replace(/<at\s+id=([^\s>]+)\s*><\/at>/g, '<@$1>')
      // [文字](链接) → <链接|文字>
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
      // **粗体** → *粗体*（先处理双星号，避免把 *斜体* 误伤）
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      // markdown 的 ## 标题在 Slack 里不存在 → 退化成粗体一行
      .replace(/^#{1,6}\s*(.+)$/gm, '*$1*')
  );
}

const section = (text: string): Record<string, unknown> => ({ type: 'section', text: { type: 'mrkdwn', text: toMrkdwn(text).slice(0, 3000) } });
const context = (text: string): Record<string, unknown> => ({ type: 'context', elements: [{ type: 'mrkdwn', text: toMrkdwn(text).slice(0, 3000) }] });
const plain = (t: string): Record<string, unknown> => ({ type: 'plain_text', text: t.slice(0, 75), emoji: true });

// 回调按钮：value 里放核心那套 {action,slug,...}，原样在 block_actions 里回来。
const BTN_STYLE: Record<CardButton['style'], string | undefined> = { primary: 'primary', danger: 'danger', default: undefined };
function btnEl(b: CardButton): Record<string, unknown> {
  const style = BTN_STYLE[b.style];
  return {
    type: 'button',
    text: plain(b.text),
    action_id: `forge_${b.action}_${b.slug}`.slice(0, 250),
    value: JSON.stringify({ action: b.action, slug: b.slug, ...(b.value ?? {}) }).slice(0, 2000),
    ...(style ? { style } : {}),
  };
}

// 开模态的按钮：value 带 ModalContext，点了之后由 adapter 自己 views.open，**不**交给核心。
function openModalBtn(text: string, ctx: ModalContext): Record<string, unknown> {
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: plain(text),
        style: 'primary',
        action_id: OPEN_MODAL_ACTION,
        value: JSON.stringify(ctx).slice(0, 2000),
      },
    ],
  };
}
// adapter 内部动作：点它是「打开模态」，不是业务动作。核心永远看不到这个 id。
export const OPEN_MODAL_ACTION = 'forge_open_form';

const decisionLines = (items: DecisionItem[]): Record<string, unknown>[] =>
  items.slice(0, DECISION_CAP).map((it, i) => {
    const opts = it.options.map((o) => `　• ${o.recommended ? '★ ' : ''}${o.label}${o.impact ? `（影响：${o.impact}）` : ''}`).join('\n');
    return section(`*${i + 1}.* ${SEV_PREFIX(it.severity)} ${it.prompt}${opts ? `\n${opts}` : ''}${it.hint ? `\n_建议：${it.hint}_` : ''}`);
  });

const findingLines = (findings: FindingLine[]): Record<string, unknown>[] =>
  findings.map((f, i) => section(`*${i + 1}.* ${SEV_PREFIX(f.severity)} ${f.lead}${(f.notes ?? []).map((n) => `\n_${n.label}：${n.text}_`).join('')}`));

// CardBlock → Block Kit（一块可展开成 0..N 个块，故返回数组）。
function renderBlock(b: CardBlock): Record<string, unknown>[] {
  switch (b.kind) {
    case 'text':
      return [section(b.md)];
    case 'note':
    case 'footnote':
      return [context(b.md)];
    case 'quote':
      return [section(`> ${b.text.replace(/\s*\n\s*/g, ' ').trim()}`)];
    case 'callout':
      return [section(`${CALLOUT_PREFIX[b.tone]} *${toMrkdwn(b.md)}*`)];
    case 'divider':
      return [{ type: 'divider' }];
    case 'stats':
      // Slack 的 section.fields 每行两列自动排布——正好对应飞书那侧的并排统计字段。
      return [{ type: 'section', fields: b.fields.slice(0, 10).map((f) => ({ type: 'mrkdwn', text: toMrkdwn(f).slice(0, 2000) })) }];
    case 'button':
      return [{ type: 'actions', elements: [btnEl(b.button)] }];
    case 'buttonRow':
      return [{ type: 'actions', elements: b.buttons.slice(0, 5).map(btnEl) }];
    case 'decisionList':
      return decisionLines(b.items);
    case 'findingList':
      return findingLines(b.findings);
    case 'decisionForm': {
      // 表单进模态：卡上只留一个按钮 + 一句说明。上下文随按钮 value 走，提交时经 private_metadata 回来。
      // 模态的**内容**（有哪些待决项）只有渲染这一刻知道 → 就地建好存起来，点按钮时取用。
      const ctx: ModalContext = { action: b.action, slug: b.slug, round: b.round, kind: 'decision' };
      rememberModal(
        ctx,
        buildDecisionModal(ctx, {
          items: b.items,
          verdict: b.verdict,
          submitText: b.submitText,
          notesLabel: b.notesLabel,
          notesPlaceholder: b.notesPlaceholder,
        }),
      );
      return [context(`共 ${Math.min(b.items.length, DECISION_CAP)} 项待决，点下面按钮填写。`), openModalBtn(b.submitText, ctx)];
    }
    case 'goForm': {
      const ctx: ModalContext = { action: 'go', slug: b.slug, kind: 'go' };
      rememberModal(ctx, buildGoModal(ctx, b.pool, b.picked));
      return [openModalBtn('✅ 立项 · 建需求', ctx)];
    }
    case 'petRow':
      return [context(`${b.mentionId ? `<@${b.mentionId}> ` : ''}${b.voice}`)];
  }
}

// CardModel → chat.postMessage 的 body 片段（attachment 承载色条，blocks 在里面）。
// text 是必给的：通知栏预览 + 不支持 blocks 的客户端全靠它。
export function renderSlackMessage(card: CardModel): { text: string; attachments: Record<string, unknown>[] } {
  const blocks: Record<string, unknown>[] = [{ type: 'header', text: plain(card.title) }];
  if (card.subtitle) blocks.push(context(card.subtitle));
  blocks.push(...card.blocks.flatMap(renderBlock));
  return { text: card.title, attachments: [{ color: COLOR_HEX[card.color], blocks: blocks.slice(0, 50) }] };
}

// ── composite message id ────────────────────────────────────────────
// chat.update 要 channel + ts；MessagingPort 只传一个不透明字符串 → 合成 "channel:ts"。
// 核心从不解析它（Phase 0 已确认 status_msg_id/intake_msg_id 全程不透明）。
export function packMsgId(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}
export function unpackMsgId(id: string): { channel: string; ts: string } | null {
  const i = id.indexOf(':');
  if (i <= 0 || i === id.length - 1) return null;
  return { channel: id.slice(0, i), ts: id.slice(i + 1) };
}

function env(): Record<string, string | undefined> {
  return loadConfig().env;
}
function watchChannels(): string[] {
  return (env().SLACK_WATCH_CHANNELS || '').split(',').map((s) => s.trim()).filter(Boolean);
}
// 私聊目标：优先 SLACK_DM_USER_ID（Slack 允许直接把 user id 当 channel 发 DM）。
function dmTarget(): string | undefined {
  return env().SLACK_DM_USER_ID || undefined;
}

async function post(channel: string | undefined, card: CardModel, threadTs?: string): Promise<string | null> {
  if (!channel) {
    log.warn('Slack 发卡跳过：未配置目标 channel');
    return null;
  }
  const r = await slackApi('chat.postMessage', { channel, ...renderSlackMessage(card), ...(threadTs ? { thread_ts: threadTs } : {}) });
  if (!r.ok) {
    log.warn(`Slack chat.postMessage 失败：${r.error}`);
    return null;
  }
  const ts = typeof r.ts === 'string' ? r.ts : null;
  const ch = typeof r.channel === 'string' ? r.channel : channel;
  return ts ? packMsgId(ch, ts) : null;
}

// 简单文本卡（无表单）：复用同一条渲染路径，避免两套外观。
const textCard = (title: string, lines: string[], color: CardColor): CardModel => ({
  color,
  title,
  blocks: lines.map((l) => ({ kind: 'text', md: l }) as CardBlock),
});

const slackPort: MessagingPort = {
  id: SLACK_PROVIDER_ID,

  async sendDmCard(card) {
    return (await post(dmTarget(), card)) !== null;
  },
  async sendDmText(title, lines, color) {
    return (await post(dmTarget(), textCard(title, lines, color))) !== null;
  },
  async replyGroupCard(replyToMessageId, card) {
    // 回复某条消息 = 发到同一 channel 的 thread 里。id 里已带 channel，无需额外配置。
    const at = unpackMsgId(replyToMessageId);
    if (!at) {
      log.warn(`Slack replyGroupCard：无法解析消息 id「${replyToMessageId}」`);
      return null;
    }
    return post(at.channel, card, at.ts);
  },
  async sendGroupCard(chatId, card) {
    return post(chatId, card);
  },
  async editGroupCard(messageId, card) {
    const at = unpackMsgId(messageId);
    if (!at) {
      log.warn(`Slack editGroupCard：无法解析消息 id「${messageId}」`);
      return false;
    }
    const r = await slackApi('chat.update', { channel: at.channel, ts: at.ts, ...renderSlackMessage(card) });
    if (!r.ok) log.warn(`Slack chat.update 失败：${r.error}`);
    return r.ok === true;
  },
  async postWebhook(title, lines, color) {
    const url = env().SLACK_WEBHOOK_URL;
    if (!url) return false;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(renderSlackMessage(textCard(title, lines, color))),
      });
      if (!res.ok) log.warn(`Slack webhook 失败：HTTP ${res.status}`);
      return res.ok;
    } catch (e) {
      log.warn(`Slack webhook 异常：${String(e).slice(0, 160)}`);
      return false;
    }
  },

  parseCardAction(raw: Record<string, unknown>): InboundCardAction | null {
    const type = raw.type;
    // ① 模态提交：上下文从 private_metadata 回来，字段从 state.values 拍平。
    if (type === 'view_submission') {
      const parsed = parseViewSubmission(raw);
      if (!parsed) return null;
      return {
        type: 'card_action',
        action: parsed.action,
        slug: parsed.slug,
        value: { action: parsed.action, slug: parsed.slug, round: parsed.round },
        formValues: parsed.formValues,
        operatorId: (raw.user as { id?: string } | undefined)?.id,
      };
    }
    // ② 普通按钮：value 里就是核心那套 {action,slug,...}。
    if (type === 'block_actions') {
      const a = (raw.actions as { action_id?: string; value?: string }[] | undefined)?.[0];
      if (!a || a.action_id === OPEN_MODAL_ACTION) return null; // 开模态是 adapter 内部动作，核心不该看到
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(a.value ?? '{}') as Record<string, unknown>;
      } catch {
        return null;
      }
      const action = String(value.action ?? '');
      const slug = String(value.slug ?? '');
      if (!action || !slug) return null;
      return { type: 'card_action', action, slug, value, formValues: {}, operatorId: (raw.user as { id?: string } | undefined)?.id };
    }
    return null;
  },

  parseMessage(raw: Record<string, unknown>): InboundMessage | null {
    const ev = (raw.event ?? raw) as Record<string, unknown>;
    if (ev.type !== 'message') return null;
    // bot 自己发的、以及编辑/删除等子类型，一律不入流程（否则状态卡会把自己当需求吃进去）。
    if (ev.subtype !== undefined || ev.bot_id) return null;
    const chatId = typeof ev.channel === 'string' ? ev.channel : '';
    const ts = typeof ev.ts === 'string' ? ev.ts : '';
    const text = typeof ev.text === 'string' ? ev.text : '';
    // Slack 的 ts 是 "1712345678.000200"（秒.微秒）→ 毫秒。缺/坏兜 now()，绝不兜 0
    //（水位插到 epoch 会让补拉从超早时间重扫历史，把旧需求重新喂进入口）。
    const createTime = ts ? Math.round(Number(ts) * 1000) || Date.now() : Date.now();
    const botId = env().SLACK_BOT_USER_ID;
    // 群消息入口闸的判定材料。im=私聊，天然定向；其余按群处理，要求 @ 了本机器人。
    // 未配 SLACK_BOT_USER_ID → 无法确认身份 → null，核心保守忽略（与飞书同语义）。
    const isGroup = ev.channel_type !== 'im';
    const mentionedBot = botId ? text.includes(`<@${botId}>`) : null;
    return {
      type: 'message',
      chatId,
      senderId: typeof ev.user === 'string' ? ev.user : undefined,
      messageId: chatId && ts ? packMsgId(chatId, ts) : undefined,
      text,
      // 链接可能藏在 blocks / attachments 里（分享卡片）→ 整条序列化成不透明文本块，交核心的文档源认领。
      searchTexts: [JSON.stringify(ev)],
      createTime,
      isGroup,
      mentionedBot,
    };
  },

  inboundConfigured(): boolean {
    const e = env();
    return !!(e.SLACK_BOT_TOKEN && e.SLACK_APP_TOKEN);
  },

  startInbound(handlers: InboundHandlers): InboundChannel {
    const channel = createSocketChannel({
      onEnvelope: (type, payload) => {
        if (type === 'events_api') {
          handlers.onMessage(payload);
          return;
        }
        if (type !== 'interactive') return;
        // 「打开模态」是 adapter 自己的活：在这里截住 + views.open，绝不外泄给核心。
        if (isOpenModal(payload)) {
          void openModal(payload).catch((e) => log.warn(`Slack views.open 异常：${String(e).slice(0, 160)}`));
          return;
        }
        handlers.onCardAction(payload);
      },
      onError: (reason) => handlers.onError(reason),
      onReconnected: () => handlers.onReconnected(),
    });
    return { connect: () => channel.connect() };
  },

  watchedChats(): string[] {
    return watchChannels();
  },

  async listHistorySince(chatId: string, sinceMs: number): Promise<InboundMessage[]> {
    // conversations.history 的 oldest 是秒（可带小数）。上限 20 页 × 50 条，与飞书侧同规格防失控。
    const oldest = (Math.floor(sinceMs) / 1000).toFixed(6);
    const out: InboundMessage[] = [];
    let cursor = '';
    for (let page = 0; page < 20; page++) {
      const r = await slackApi('conversations.history', { channel: chatId, oldest, limit: 50, ...(cursor ? { cursor } : {}) });
      if (!r.ok) {
        log.warn(`补拉频道历史失败（${chatId}）：${r.error}`);
        return out; // best-effort：返回已得，绝不抛
      }
      for (const m of (r.messages as Record<string, unknown>[] | undefined) ?? []) {
        const parsed = slackPort.parseMessage({ ...m, type: 'message', channel: chatId });
        if (parsed) out.push(parsed);
      }
      const next = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
      if (r.has_more && !next) {
        log.warn(`SLACK_PAGINATION_DRIFT：has_more=true 但无 next_cursor（疑似 conversations.history 分页 schema 变更），${chatId} 本轮提前结束`);
      }
      if (!r.has_more || !next) break;
      cursor = next;
    }
    // Slack 按时间**倒序**返回；核心的补拉循环按升序推进水位 → 这里翻过来。
    return out.reverse();
  },

  async probe(): Promise<InboundProbe> {
    const e = env();
    const chat = watchChannels()[0];
    if (!e.SLACK_BOT_TOKEN || !chat) return { available: false, ok: false, detail: 'Slack bot/观察频道未配齐（跳过）' };
    const r = await slackApi('conversations.history', { channel: chat, limit: 1 });
    const raw = JSON.stringify(r).slice(0, 400);
    if (!r.ok) {
      return { available: true, ok: false, kind: 'auth', detail: `conversations.history error=${r.error}（凭据/权限/未加频道）`, raw };
    }
    // 验的正是 listHistorySince 依赖的信封：messages 数组 + has_more。
    const hasMessages = Array.isArray(r.messages);
    const hasMore = typeof r.has_more === 'boolean';
    if (!hasMessages || !hasMore) {
      return { available: true, ok: false, kind: 'drift', detail: `conversations.history 信封缺字段（messages=${hasMessages} has_more=${hasMore}）`, raw };
    }
    return { available: true, ok: true, detail: 'Slack conversations.history 分页信封完好' };
  },
};

function isOpenModal(payload: Record<string, unknown>): boolean {
  if (payload.type !== 'block_actions') return false;
  const a = (payload.actions as { action_id?: string }[] | undefined)?.[0];
  return a?.action_id === OPEN_MODAL_ACTION;
}

// 点了「填写」按钮 → 用 trigger_id 开模态。trigger_id 3 秒内有效，所以这条路径不做任何多余的 IO。
async function openModal(payload: Record<string, unknown>): Promise<void> {
  const triggerId = typeof payload.trigger_id === 'string' ? payload.trigger_id : '';
  const a = (payload.actions as { value?: string }[] | undefined)?.[0];
  if (!triggerId || !a?.value) return;
  let ctx: ModalContext;
  try {
    ctx = JSON.parse(a.value) as ModalContext;
  } catch {
    log.warn('Slack 开模态：按钮 value 不是合法 JSON');
    return;
  }
  const spec = pendingModal(ctx) ?? degradedModal(ctx);
  const r = await slackApi('views.open', { trigger_id: triggerId, view: spec });
  if (!r.ok) log.warn(`Slack views.open 失败：${r.error}`);
}

// 卡片还挂在 Slack 上、但本进程重启过 → 内存里的模态内容没了。
// **绝不静默失效**（点了没反应是最糟的形态）：降级成一个只有自由文本的模态，人照样能答，
// 只是少了逐条下拉。核心那侧 formValues 仍然是同一套键（verdict/notes/assignee）。
function degradedModal(ctx: ModalContext): Record<string, unknown> {
  log.warn(`Slack 开模态：${ctx.action}/${ctx.slug} 的表单内容不在内存里（守护重启过）→ 降级为纯文本模态`);
  if (ctx.kind === 'go') {
    return buildGoModal(ctx, [], null);
  }
  return buildDecisionModal(ctx, {
    items: [],
    verdict: true,
    submitText: '提交',
    notesLabel: '补充说明',
    notesPlaceholder: '守护重启后逐条选项已不可用，请在此直接写下你的答复',
  });
}

// 模态内容的暂存：渲染卡片时把「这张卡上的表单该长什么样」记下来，点按钮时取出来开模态。
// 为什么需要：Slack 的表单不在卡片里，可待决项/DRI 池只有渲染那一刻才知道。按 slug+action 存，
// 后渲染的覆盖先渲染的（同一条需求的新一轮卡片本就应该覆盖旧的）。
const MODAL_SPECS = new Map<string, Record<string, unknown>>();
const specKey = (action: string, slug: string): string => `${action}:${slug}`;

export function rememberModal(ctx: ModalContext, view: Record<string, unknown>): void {
  MODAL_SPECS.set(specKey(ctx.action, ctx.slug), view);
}
function pendingModal(ctx: ModalContext): Record<string, unknown> | null {
  return MODAL_SPECS.get(specKey(ctx.action, ctx.slug)) ?? null;
}
export function __clearModalSpecsForTest(): void {
  MODAL_SPECS.clear();
}

export { slackPort, buildDecisionModal, buildGoModal };
