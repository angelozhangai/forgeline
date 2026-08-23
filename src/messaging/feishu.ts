// Thin transport seam — **the Feishu adapter** (an implementation of MessagingPort).
// Outbound: render the provider-neutral CardModel into Feishu card 2.0 JSON (renderFeishuCard) and send
// it via feishu/*.
// Inbound: parse Feishu's raw events into provider-neutral InboundCardAction / InboundMessage.
//
// Design: every Feishu JSON shape and markdown extension (<font> colouring / select_static / form /
// column_set / <at> mentions) is confined to this file. The core (notify/listen) holds only CardModel
// semantic blocks and touches no Feishu tag.
// The one controlled leftover: the content of a few prose blocks (text/note/footnote/quote) may carry
// portable inline emphasis such as <font>. That is prose *content* rather than structure, and the Slack
// adapter simply converts <font> into its own emphasis for prose blocks.
import * as lark from '@larksuiteoapi/node-sdk';
import { sendBotCardObject, sendBotCard, botTenantToken, botOpenId, botOpenIdCached, FEISHU_BASE } from '../feishu/dm.ts';
import { chatIsGroup, listMessages, type FeishuHistMsg } from '../feishu/history.ts';
import { replyCard, patchCard, sendCardToChat } from '../feishu/group.ts';
import { postCard } from '../feishu/notify.ts';
import { petImageKey } from '../feishu/petAssets.ts';
import { FUN_ON } from '../util/pet.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { answerableDecisions, DECISION_CAP, type DecisionItem } from '../gates/envelopes.ts';
import type { CardModel, CardBlock, CardButton, CardColor, CalloutTone, FindingLine, InboundCardAction, InboundMessage } from './model.ts';
import type { MessagingPort, InboundHandlers, InboundChannel, InboundProbe } from './port.ts';

// Pixel-pet animation switch: on by default, but an image is only actually attached when keys.json has
// the matching image_key (otherwise it falls back to plain text / emoji). FORGE_PET_GIF=0 forces it off.
const PET_GIF_ON = FUN_ON && process.env.FORGE_PET_GIF !== '0';

// Remediation guidance shown to the operator when auth fails (rides the probe result up into the alert).
// How to fix it is provider knowledge; the core does not speak on the provider's behalf.
const FEISHU_AUTH_FIX = 'Check the Feishu bot credentials and permissions (FEISHU_BOT_APP_ID/SECRET, and whether the bot has been added to the chat)';

// -- Feishu card 2.0 element primitives (moved verbatim from notify.ts, byte for byte) ---------------
const md = (content: string): Record<string, unknown> => ({ tag: 'markdown', content });
const hr = { tag: 'hr' };
const grey = (t: string): Record<string, unknown> => md(`<font color='grey'>${t}</font>`);
// Small grey footnote: card 2.0 dropped the note block, so this uses markdown's text_size:notation (one
// size smaller) plus grey.
const small = (content: string): Record<string, unknown> => ({ tag: 'markdown', text_size: 'notation', content: `<font color='grey'>${content}</font>` });
// Quote block: markdown's `>`, turning a summary into a low-key quotation.
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
// Callout tone -> a Feishu markdown colour.
const CALLOUT_COLOR: Record<CalloutTone, string> = { danger: 'red', warning: 'orange', info: 'blue' };
const calloutEl = (tone: CalloutTone, content: string): Record<string, unknown> => md(`<font color='${CALLOUT_COLOR[tone]}'>${content}</font>`);

// The pet avatar img element (a 56px animation, rounded corners, centre-cropped).
function petImgEl(key: string): Record<string, unknown> {
  return { tag: 'img', img_key: key, alt: { tag: 'plain_text', content: 'requirement pet' }, scale_type: 'crop_center', size: '56px 56px', corner_radius: '8px' };
}
// One row of "avatar on the left, text on the right": with an image_key -> column_set(avatar|text);
// without an image -> just the text markdown (graceful degradation).
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

// Indent for option lines. Markdown collapses leading ASCII spaces, so a non-breaking space is used to
// keep options visually nested under their question. (This used to be U+3000 IDEOGRAPHIC SPACE, which is
// CJK punctuation; built from its code point so no invisible character sits in the source.)
const INDENT = String.fromCharCode(0xa0, 0xa0);

// Open questions listed one by one: the question, each option (a star on the recommendation plus its
// impact as a sub-line), and a hint.
const decisionItemsMd = (items: DecisionItem[]): unknown[] =>
  items.slice(0, DECISION_CAP).map((it, i) => {
    const opts = it.options
      .map((o) => `${INDENT}- ${o.recommended ? '★ ' : ''}${o.label}${o.impact ? ` (impact: ${o.impact})` : ''}`)
      .join('\n');
    return md(
      `**${i + 1}.** ${sevTag(it.severity)} ${it.prompt}` +
        (opts ? `\n${opts}` : '') +
        (it.hint ? `\n<font color='grey'>Suggestion: ${it.hint}</font>` : ''),
    );
  });

// Residual review findings / open questions one by one (a severity label plus grey sub-lines for
// location and suggestion).
const findingItemsMd = (findings: FindingLine[]): unknown[] =>
  findings.map((f, i) =>
    md(`**${i + 1}.** ${sevTag(f.severity)} ${f.lead}${(f.notes ?? []).map((n) => `\n<font color='grey'>${n.label}: ${n.text}</font>`).join('')}`),
  );

// The decision form: every open question that has options becomes a dropdown (a star on the
// recommendation, plus an "other" fallback), followed by a global notes box and a submit button.
// answerableDecisions guarantees the select's name=ask_<id> lines up **in the same order** as
// composeDecisionAnswer's reassembly, so answers can never be attached to the wrong question.
// verdict=true (Gate A) adds an overall-verdict dropdown. `round` is passed through, which stops Feishu
// from de-duplicating away a second-round submission on an in-place-edited channel card.
const decisionFormEl = (
  slug: string,
  items: DecisionItem[],
  o: { action: string; round?: number; verdict?: boolean; submitText: string; notesLabel: string; notesPlaceholder: string },
): Record<string, unknown> => {
  const selects = answerableDecisions(items).map(({ id, item }) => ({
    tag: 'select_static',
    name: `ask_${id}`,
    placeholder: { tag: 'plain_text', content: `${id}: choose…` },
    options: [
      ...item.options.slice(0, 10).map((opt) => {
        const v = opt.label.slice(0, 120);
        return { text: { tag: 'plain_text', content: `${opt.recommended ? '★ ' : ''}${v}` }, value: v };
      }),
      { text: { tag: 'plain_text', content: 'Other (write it in the notes below)' }, value: '__other__' },
    ],
  }));
  const verdictEl = o.verdict
    ? [
        {
          tag: 'select_static',
          name: 'verdict',
          placeholder: { tag: 'plain_text', content: 'Overall verdict…' },
          options: [
            { text: { tag: 'plain_text', content: '✅ Accept the suggestions and confirm' }, value: 'accept' },
            { text: { tag: 'plain_text', content: '📝 Partially accept (see the per-question answers / notes)' }, value: 'partial' },
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

// The filing form (DM to the maintainer): a DRI dropdown (defaulting to the recommendation) plus a
// "file it / create issues" submit -> the go callback (form_value.assignee carries the chosen person).
const goFormEl = (slug: string, pool: string[], picked: string | null): Record<string, unknown> => ({
  tag: 'form',
  name: 'go_form',
  elements: [
    {
      tag: 'select_static',
      name: 'assignee',
      placeholder: { tag: 'plain_text', content: 'Assign a DRI…' },
      ...(picked && pool.includes(picked) ? { initial_option: picked } : {}),
      options: pool.map((c) => ({ text: { tag: 'plain_text', content: c }, value: c })),
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '✅ File it · create issues' },
      type: 'primary',
      form_action_type: 'submit',
      name: 'submit',
      behaviors: [{ type: 'callback', value: { action: 'go', slug } }],
    },
  ],
});

const btnEl = (b: CardButton): Record<string, unknown> => cbBtn(b.text, b.style, b.action, b.slug, b.value ?? {});

// CardBlock -> Feishu card 2.0 elements (one block can expand into 0..N elements, hence the array and
// the flatMap outside).
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

// CardModel -> Feishu card 2.0 JSON. The subtitle key is emitted only when non-empty (matching the
// original buildCard.card()).
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

// -- Inbound: Feishu raw events -> provider-neutral events -------------------------------------------
// Dig the form values out of the raw event (confirm_form's verdict / notes / ask_* / assignee).
// Exported so unit tests can override it directly.
export function formValue(evt: Record<string, unknown>): Record<string, string> {
  const raw = evt.raw as Record<string, unknown> | undefined;
  const ev = (raw?.event ?? raw) as Record<string, unknown> | undefined;
  const action = ev?.action as Record<string, unknown> | undefined;
  const fv = action?.form_value as Record<string, string> | undefined;
  return fv ?? {};
}

// The watched-chat list (backfill iteration and the contract probe's sampling share one parse, so the
// comma splitting is not written twice and cannot drift).
function watchChats(): string[] {
  const env = loadConfig().env;
  return (env.FEISHU_WATCH_CHATS || env.FEISHU_REVIEW_CHAT_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// A history entry -> a provider-neutral InboundMessage. Same fallback rules as parseMessage: the body
// comes from the text inside body.content, and the whole entry is serialised as an extra text block so
// the core can still extract links (a share card's or rich text's link is not in the body).
function histToInbound(m: FeishuHistMsg, chatId: string, isGroup: boolean): InboundMessage {
  let text = '';
  if (m.body?.content) {
    try {
      text = (JSON.parse(m.body.content) as { text?: string }).text ?? '';
    } catch {
      text = m.body.content;
    }
  }
  const n = Number(m.create_time) || 0;
  const createTime = n > 0 && n < 1e12 ? n * 1000 : n; // Feishu history gives seconds, live events give milliseconds -> normalise to milliseconds
  const botId = botOpenIdCached();
  // A missing `mentions` (the envelope has no such field) is indistinguishable from "genuinely nobody
  // mentioned it", so the former can only be reported as null (unconfirmable).
  // The mapping is faithful here so that "do history entries actually carry mentions" is answered by one
  // run against a real tenant rather than by guessing.
  const mentionedBot = m.mentions === undefined || botId === null ? null : m.mentions.some((mn) => mn?.id?.open_id === botId);
  return {
    type: 'message',
    chatId: m.chat_id || chatId,
    senderId: m.sender?.id,
    messageId: m.message_id,
    text,
    searchTexts: [JSON.stringify(m)],
    createTime,
    isGroup, // decided by listHistorySince: use the entry's own chat_type when present, otherwise ask for the conversation type once
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
    // A missing or broken createTime falls back to now(), **never** to 0 — otherwise listen would set
    // that chat's watermark to the epoch when advancing the cursor, making backfill rescan history from
    // an absurdly early time and feed old PRD links back into intake (duplicate reminders, pointless
    // ticks). This preserves the old pipeline's semantics.
    const createTime = Number(raw.createTime) || Date.now();
    let text = typeof raw.text === 'string' ? raw.text : '';
    if (!text && msg?.content) {
      try {
        text = (JSON.parse(msg.content) as { text?: string }).text ?? '';
      } catch {
        text = msg.content;
      }
    }
    // The link is often not in the plain text (a document share card, a rich-text post) — serialise the
    // whole event into one opaque text block as a fallback, and let the core run its link extraction over
    // text + searchTexts.
    const searchTexts = [JSON.stringify(raw)];
    // The material for the channel intake gate: is this a channel message, and was this bot mentioned.
    // It reads the **server-populated mentions[].id.open_id** on the event (present for every message
    // type, including document shares and rich-text posts — exactly the cases the SDK's body
    // normalisation misses, which is why requireMention was turned off) and compares it with the bot's
    // own open_id.
    // The bot's open_id not being ready (env unconfigured and bot/v3/info not warmed up) ->
    // mentionedBot=null, and the core conservatively ignores it.
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
    // The Feishu long-lived channel: construction, event subscription and reconnection are all confined
    // to the adapter (the core touches neither lark nor the channel lifecycle).
    const env = loadConfig().env;
    const appId = env.FEISHU_BOT_APP_ID as string;
    const appSecret = env.FEISHU_BOT_APP_SECRET as string;
    const wsDebug = process.env.FORGE_WS_DEBUG === '1';
    // Warm up the bot's own open_id (used by the channel intake gate to detect mentions) — fill the cache
    // before connecting, so the first channel message does not hit "identity not ready".
    void botOpenId();
    const channel = lark.createLarkChannel({
      appId,
      appSecret,
      includeRawEvent: true,
      loggerLevel: wsDebug ? lark.LoggerLevel.debug : lark.LoggerLevel.info,
      // The SDK is deliberately **not** allowed to filter by mention: a mention in a document share or
      // rich-text message often is not recognised by the SDK's body normalisation, and would be dropped
      // silently.
      // Instead we judge mentions ourselves from the **server-populated mentions** on the event, in
      // parseMessage/listen (more reliable, and it covers share cards). The "a channel message without a
      // bot mention does not enter the pipeline" gate lands in handleMessage (see daemon/listen.ts).
      policy: { requireMention: false },
    });
    channel.on('cardAction', (evt: unknown) => handlers.onCardAction(evt as Record<string, unknown>));
    channel.on('message', (evt: unknown) => handlers.onMessage(evt as Record<string, unknown>));
    channel.on('reject', (e: unknown) => log.warn(`Message blocked by policy: ${JSON.stringify(e).slice(0, 200)}`));
    channel.on('error', (e: unknown) => handlers.onError(String(e)));
    channel.on('reconnected', () => handlers.onReconnected());
    return { connect: () => channel.connect() };
  },
  watchedChats(): string[] {
    return watchChats();
  },
  async listHistorySince(chatId: string, sinceMs: number): Promise<InboundMessage[]> {
    // Feishu's start_time is in **seconds**: flooring it can bring back messages from the watermark's own
    // second, so the core filters again by createTime in milliseconds.
    const items = await listMessages(chatId, Math.floor(sinceMs / 1000));
    // Is this conversation a channel or a DM — this **must not be assumed to be a channel**. Backfill
    // iterates the cursor table (cursors.allChats), and the cursor is advanced by every inbound message,
    // so DMs are naturally in there too. Treating DM history as channel messages makes them hit the
    // "nobody @-mentioned me" intake gate and be dropped: requirements sent by DM while offline silently
    // vanish, which is precisely what backfill exists to prevent.
    // Use the entry's own chat_type when it has one (saving the round trip entirely); otherwise ask for
    // the conversation type once (memoised by chatId).
    const fromItem = items.find((m) => typeof m.chat_type === 'string');
    const isGroup = fromItem ? fromItem.chat_type === 'group' : ((await chatIsGroup(chatId)) ?? true);
    // Note the fallback direction: when it cannot be decided, treat it as a **channel** (today's
    // behaviour), not as a DM. The two directions have asymmetric costs — wrongly treating it as a DM
    // sends every casually shared document into Gate A (real money), while wrongly treating it as a
    // channel merely continues today's known gap, and a chatIsGroup failure has already emitted a
    // warning, so it is not silent.
    return items.map((m) => histToInbound(m, chatId, isGroup));
  },
  async probe(): Promise<InboundProbe> {
    // Read-only, page_size=1, no side effects: what it verifies is exactly the im/v1/messages pagination
    // envelope that listHistorySince depends on.
    // Feishu IM API details (base URL, token, pagination fields) stay in the adapter and do not leak into
    // the llm/health layers.
    const { env } = loadConfig();
    const chat = watchChats()[0];
    if (!env.FEISHU_BOT_APP_ID || !env.FEISHU_BOT_APP_SECRET || !chat) {
      return { available: false, ok: false, detail: 'Feishu bot / watched chat not fully configured (skipped)' };
    }
    const token = await botTenantToken();
    if (!token) {
      return { available: true, ok: false, kind: 'auth', detail: 'Failed to obtain tenant_access_token (auth or network; not necessarily drift)', authFix: FEISHU_AUTH_FIX };
    }
    try {
      const url = new URL(`${FEISHU_BASE}/im/v1/messages`);
      url.searchParams.set('container_id_type', 'chat');
      url.searchParams.set('container_id', chat);
      url.searchParams.set('page_size', '1');
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const j = (await res.json()) as { code?: number; msg?: string; data?: Record<string, unknown> };
      if (j.code !== 0) {
        return { available: true, ok: false, kind: 'auth', detail: `im/v1/messages code=${j.code} (${(j.msg ?? '').slice(0, 80)}; possibly permissions, or the bot is not in the chat — not necessarily drift)` };
      }
      const d = j.data ?? {};
      const missing: string[] = [];
      if (!('items' in d) || !Array.isArray(d.items)) missing.push('data.items');
      if (!('has_more' in d)) missing.push('data.has_more');
      if (!('page_token' in d)) missing.push('data.page_token');
      return missing.length
        ? { available: true, ok: false, kind: 'drift', detail: `Feishu im/v1/messages is missing pagination envelope fields: ${missing.join(', ')} (the API schema may have changed)`, raw: JSON.stringify(j).slice(0, 800) }
        : { available: true, ok: true, detail: 'Feishu im/v1/messages pagination envelope intact' };
    } catch (e) {
      return { available: true, ok: false, kind: 'auth', detail: `Feishu probe network error: ${String(e).slice(0, 100)}` };
    }
  },
};

export { feishuPort };
