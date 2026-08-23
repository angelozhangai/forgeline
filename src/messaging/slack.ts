// Thin transport seam — **the Slack adapter** (the second implementation of MessagingPort).
// Outbound: CardModel -> Block Kit (plus the colour bar on an attachment); inbound: Slack events ->
// provider-neutral events.
//
// Every Slack shape is confined to this file and slack/*: the mrkdwn dialect, Block Kit block types,
// composite message ids, and the modal round trip. The core (notify/listen/worker/actions) never
// changed by a line for Slack — which is exactly what this seam is for.
//
// Three things are **necessarily** different from Feishu, and all three are held inside this layer:
//  · **Forms**: Slack's input blocks are only legal inside a modal -> a button on the card ->
//    views.open -> one view_submission carrying every field back (see slack/modal.ts). The shape of
//    InboundCardAction.formValues is unchanged.
//  · **Message ids**: chat.update needs both channel and ts, while editGroupCard(messageId,…) has only
//    one value -> an opaque composite "channel:ts" is used externally. The core never parses
//    status_msg_id / intake_msg_id, so this is safe.
//  · **Colour**: Block Kit has no card-level colour -> the semantic colour rides on the vertical bar
//    from attachment.color.
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { slackApi } from '../slack/web.ts';
import { createSocketChannel } from '../slack/socket.ts';
import { buildDecisionModal, buildGoModal, parseViewSubmission, type ModalContext } from '../slack/modal.ts';
import { BK_LIMIT, explain, validateAttachments, validateView } from '../slack/blockkit.ts';
import { blank, mrkdwnText, plainText } from '../slack/text.ts';
import { DECISION_CAP, type DecisionItem } from '../gates/envelopes.ts';
import type { CalloutTone, CardBlock, CardButton, CardColor, CardModel, FindingLine, InboundCardAction, InboundMessage } from './model.ts';
import type { InboundChannel, InboundHandlers, InboundProbe, MessagingPort } from './port.ts';

export const SLACK_PROVIDER_ID = 'slack';

// Remediation guidance shown to the operator when auth fails (rides the probe result up into the alert).
const SLACK_AUTH_FIX =
  'Check the Slack token and permissions (has SLACK_BOT_TOKEN expired, has the bot been /invited to the channel, is the channels:history scope granted)';

// Semantic colour -> the attachment's left-hand colour bar. Slack only accepts hex; it has no notion of
// template colours.
const COLOR_HEX: Record<CardColor, string> = {
  red: '#e01e5a',
  blue: '#2f7ed8',
  green: '#2eb886',
  grey: '#868686',
  orange: '#e8912d',
};
// Callout tone -> an emoji prefix. Block Kit body text has no inline colouring, so emoji are the only
// portable way to emphasise.
const CALLOUT_PREFIX: Record<CalloutTone, string> = { danger: '🔴', warning: '🟠', info: '🔵' };
const SEV_PREFIX = (s?: string): string => (s === 'high' ? '🔴 [high]' : s === 'med' ? '🟠 [med]' : '⚪️ [low]');

// -- markdown -> Slack mrkdwn ------------------------------------------------
// The core's prose blocks carry generic markdown (plus a little leftover <font>/<at> from the Feishu
// era). Slack's dialect differs: bold is a single asterisk, links are <url|text>, and mentions are
// <@Uxxx>. This conversion is at the **content** level, not the structural one — structure (block
// types) is decided by renderBlock, and this only governs how one string is written.
export function toMrkdwn(src: string): string {
  return (
    (src ?? '')
      // First strip Feishu's inline markup: <font color='grey'>x</font> -> x; <at id=ou_x></at> -> <@ou_x>
      .replace(/<font\s+color=['"]?[\w-]+['"]?>([\s\S]*?)<\/font>/g, '$1')
      .replace(/<at\s+id=([^\s>]+)\s*><\/at>/g, '<@$1>')
      // [text](url) -> <url|text>
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
      // **bold** -> *bold* (handle the double asterisk first, so *italic* is not caught by mistake)
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      // markdown's ## headings do not exist in Slack -> degrade to a bold line
      .replace(/^#{1,6}\s*(.+)$/gm, '*$1*')
  );
}

// All capping goes through slack/text.ts (the same implementation as the modal side): cut on **code
// points**, and never emit empty text.
// A bare `.slice()` here used to hide two traps that only surface in a real workspace — splitting an
// emoji's surrogate pair in half, or emitting an empty plain_text. Either gets the whole message
// rejected by Slack (invalid_blocks), and the card simply never appears.
const section = (text: string): Record<string, unknown> => ({ type: 'section', text: mrkdwnText(toMrkdwn(text), BK_LIMIT.sectionText) });
const context = (text: string): Record<string, unknown> => ({ type: 'context', elements: [mrkdwnText(toMrkdwn(text), BK_LIMIT.contextText)] });
const plain = (t: string, max: number = BK_LIMIT.buttonText): Record<string, unknown> => plainText(t, max);

// Callback buttons: the core's {action,slug,...} goes in `value` and comes back verbatim in block_actions.
const BTN_STYLE: Record<CardButton['style'], string | undefined> = { primary: 'primary', danger: 'danger', default: undefined };
// A button value over 2000 characters **must not be truncated**: the truncated JSON can never be parsed
// back, so parseCardAction drops the callback on the floor and the person still just sees "the button
// does nothing". Better to lose the passed-through fields than the {action,slug} the core actually needs.
function btnValue(b: CardButton): string {
  const full = JSON.stringify({ action: b.action, slug: b.slug, ...(b.value ?? {}) });
  if (Array.from(full).length <= BK_LIMIT.buttonValue) return full;
  log.warn(`Slack button value exceeds ${BK_LIMIT.buttonValue} characters (${b.action}/${b.slug}) -> keeping only {action,slug}; the passed-through fields were dropped`);
  return JSON.stringify({ action: b.action, slug: b.slug });
}

function btnEl(b: CardButton): Record<string, unknown> {
  const style = BTN_STYLE[b.style];
  return {
    type: 'button',
    text: plain(b.text),
    action_id: `forge_${b.action}_${b.slug}`.slice(0, BK_LIMIT.actionId - 5),
    value: btnValue(b),
    ...(style ? { style } : {}),
  };
}

// The button that opens a modal: its value carries the ModalContext, and on click the adapter calls
// views.open itself — this **never** reaches the core.
function openModalBtn(text: string, ctx: ModalContext): Record<string, unknown> {
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: plain(text),
        style: 'primary',
        action_id: OPEN_MODAL_ACTION,
        value: JSON.stringify(ctx).slice(0, BK_LIMIT.buttonValue),
      },
    ],
  };
}
// An adapter-internal action: clicking it means "open the modal", not a business action. The core never
// sees this id.
export const OPEN_MODAL_ACTION = 'forge_open_form';

// Indent for option lines. mrkdwn collapses leading ASCII spaces, so a non-breaking space keeps options
// visually nested under their question. (This used to be U+3000 IDEOGRAPHIC SPACE, which is CJK
// punctuation; built from its code point so no invisible character sits in the source.)
const INDENT = String.fromCharCode(0xa0, 0xa0);

const decisionLines = (items: DecisionItem[]): Record<string, unknown>[] =>
  items.slice(0, DECISION_CAP).map((it, i) => {
    const opts = it.options.map((o) => `${INDENT}• ${o.recommended ? '★ ' : ''}${o.label}${o.impact ? ` (impact: ${o.impact})` : ''}`).join('\n');
    return section(`*${i + 1}.* ${SEV_PREFIX(it.severity)} ${it.prompt}${opts ? `\n${opts}` : ''}${it.hint ? `\n_Suggestion: ${it.hint}_` : ''}`);
  });

const findingLines = (findings: FindingLine[]): Record<string, unknown>[] =>
  findings.map((f, i) => section(`*${i + 1}.* ${SEV_PREFIX(f.severity)} ${f.lead}${(f.notes ?? []).map((n) => `\n_${n.label}: ${n.text}_`).join('')}`));

// CardBlock -> Block Kit (one block can expand into 0..N blocks, hence the array).
// A block with no content is **simply not emitted**: Slack's section/context reject empty text, and the
// same goes for empty fields and empty elements — any of them is not "one block short" but the whole
// message being rejected (invalid_blocks), and the card disappears. Emitting a placeholder is wrong too;
// that is just noise.
function renderBlock(b: CardBlock): Record<string, unknown>[] {
  switch (b.kind) {
    case 'text':
      return blank(b.md) ? [] : [section(b.md)];
    case 'note':
    case 'footnote':
      return blank(b.md) ? [] : [context(b.md)];
    case 'quote': {
      const line = b.text.replace(/\s*\n\s*/g, ' ').trim();
      return line ? [section(`> ${line}`)] : [];
    }
    case 'callout':
      return blank(b.md) ? [] : [section(`${CALLOUT_PREFIX[b.tone]} *${toMrkdwn(b.md)}*`)];
    case 'divider':
      return [{ type: 'divider' }];
    case 'stats':
      // Slack's section.fields lays itself out two columns per row — which maps exactly onto the
      // side-by-side stat fields on the Feishu side.
      return b.fields.length
        ? [{ type: 'section', fields: b.fields.slice(0, BK_LIMIT.fieldsPerSection).map((f) => mrkdwnText(toMrkdwn(f), BK_LIMIT.fieldText)) }]
        : [];
    case 'button':
      return [{ type: 'actions', elements: [btnEl(b.button)] }];
    case 'buttonRow':
      return b.buttons.length ? [{ type: 'actions', elements: b.buttons.slice(0, 5).map(btnEl) }] : [];
    case 'decisionList':
      return decisionLines(b.items);
    case 'findingList':
      return findingLines(b.findings);
    case 'decisionForm': {
      // The form moves into a modal: the card keeps only a button and a line of explanation. The context
      // travels on the button's value and comes back through private_metadata on submit.
      // The modal's **content** (which open questions there are) is known only at render time -> build it
      // here and store it, to be used when the button is clicked.
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
      return [context(`${Math.min(b.items.length, DECISION_CAP)} open questions — click the button below to answer.`), openModalBtn(b.submitText, ctx)];
    }
    case 'goForm': {
      const ctx: ModalContext = { action: 'go', slug: b.slug, kind: 'go' };
      rememberModal(ctx, buildGoModal(ctx, b.pool, b.picked));
      return [openModalBtn('✅ File it · create issues', ctx)];
    }
    case 'petRow': {
      const line = `${b.mentionId ? `<@${b.mentionId}> ` : ''}${b.voice}`;
      return blank(line) ? [] : [context(line)];
    }
  }
}

// CardModel -> the body fragment for chat.postMessage (the attachment carries the colour bar, with the
// blocks inside it).
// `text` must always be supplied: the notification preview and any client that does not support blocks
// rely entirely on it.
// A Slack message holds at most 50 blocks. Going over must truncate — but **never silently**: a review
// card with its tail cut off looks completely normal, just missing a few open questions, and that is the
// hardest class of bug to notice.

export function renderSlackMessage(card: CardModel): { text: string; attachments: Record<string, unknown>[] } {
  const blocks: Record<string, unknown>[] = [{ type: 'header', text: plain(card.title, BK_LIMIT.headerText) }];
  if (card.subtitle) blocks.push(context(card.subtitle));
  blocks.push(...card.blocks.flatMap(renderBlock));
  if (blocks.length > BK_LIMIT.blocksPerMessage) {
    log.warn(`Slack card exceeds the ${BK_LIMIT.blocksPerMessage}-block limit (${blocks.length}); the tail was truncated: "${card.title}"`);
  }
  // `text` must not be empty either — it is the notification preview, and the only thing visible on
  // clients that do not support blocks.
  return { text: card.title.trim() || 'Forge', attachments: [{ color: COLOR_HEX[card.color], blocks: blocks.slice(0, BK_LIMIT.blocksPerMessage) }] };
}

// -- composite message id ----------------------------------------------------
// chat.update needs channel + ts; MessagingPort passes only one opaque string -> compose "channel:ts".
// The core never parses it (Phase 0 confirmed status_msg_id/intake_msg_id stay opaque throughout).
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
// DM target: prefer SLACK_DM_USER_ID (Slack allows a user id to be used directly as the channel for a DM).
function dmTarget(): string | undefined {
  return env().SLACK_DM_USER_ID || undefined;
}

// When Slack rejects a message it replies with nothing but `invalid_blocks` — **it does not say which
// block or which field** — so all a person sees is "the card never showed up".
// It has already failed at that point, so running one structural self-check over the payload costs
// nothing and translates it into "block 3, section.text is empty". It never runs on the happy path.
function why(attachments: Record<string, unknown>[]): string {
  return ` — ${explain(validateAttachments(attachments))}`;
}

async function post(channel: string | undefined, card: CardModel, threadTs?: string): Promise<string | null> {
  if (!channel) {
    log.warn('Slack card skipped: no target channel configured');
    return null;
  }
  const msg = renderSlackMessage(card);
  const r = await slackApi('chat.postMessage', { channel, ...msg, ...(threadTs ? { thread_ts: threadTs } : {}) });
  if (!r.ok) {
    log.warn(`Slack chat.postMessage failed: ${r.error}${why(msg.attachments)}`);
    return null;
  }
  const ts = typeof r.ts === 'string' ? r.ts : null;
  const ch = typeof r.channel === 'string' ? r.channel : channel;
  return ts ? packMsgId(ch, ts) : null;
}

// A simple text card (no form): reuses the same render path, avoiding two separate looks.
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
    // Replying to a message = posting into a thread in the same channel. The id already carries the
    // channel, so no extra configuration is needed.
    const at = unpackMsgId(replyToMessageId);
    if (!at) {
      log.warn(`Slack replyGroupCard: cannot parse message id "${replyToMessageId}"`);
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
      log.warn(`Slack editGroupCard: cannot parse message id "${messageId}"`);
      return false;
    }
    const msg = renderSlackMessage(card);
    const r = await slackApi('chat.update', { channel: at.channel, ts: at.ts, ...msg });
    if (!r.ok) log.warn(`Slack chat.update failed: ${r.error}${why(msg.attachments)}`);
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
      if (!res.ok) log.warn(`Slack webhook failed: HTTP ${res.status}`);
      return res.ok;
    } catch (e) {
      log.warn(`Slack webhook threw: ${String(e).slice(0, 160)}`);
      return false;
    }
  },

  parseCardAction(raw: Record<string, unknown>): InboundCardAction | null {
    const type = raw.type;
    // 1. A modal submission: the context comes back from private_metadata, the fields are flattened out
    //    of state.values.
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
    // 2. An ordinary button: `value` already holds the core's {action,slug,...}.
    if (type === 'block_actions') {
      const a = (raw.actions as { action_id?: string; value?: string }[] | undefined)?.[0];
      if (!a || a.action_id === OPEN_MODAL_ACTION) return null; // opening a modal is adapter-internal; the core should never see it
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
    // Messages the bot sent itself, and subtypes such as edits and deletions, never enter the pipeline
    // (otherwise the status card would ingest itself as a requirement).
    if (ev.subtype !== undefined || ev.bot_id) return null;
    const chatId = typeof ev.channel === 'string' ? ev.channel : '';
    const ts = typeof ev.ts === 'string' ? ev.ts : '';
    const text = typeof ev.text === 'string' ? ev.text : '';
    // Slack's ts is "1712345678.000200" (seconds.microseconds) -> milliseconds. Missing or broken falls
    // back to now(), never to 0 (a watermark at the epoch would make backfill rescan history from an
    // absurdly early time and feed old requirements back into intake).
    const createTime = ts ? Math.round(Number(ts) * 1000) || Date.now() : Date.now();
    const botId = env().SLACK_BOT_USER_ID;
    // The material for the channel intake gate. im = a DM, inherently directed; everything else is
    // treated as a channel and requires a mention of this bot.
    // SLACK_BOT_USER_ID unconfigured -> identity cannot be confirmed -> null, and the core conservatively
    // ignores it (the same semantics as Feishu).
    const isGroup = ev.channel_type !== 'im';
    const mentionedBot = botId ? mentionsBot(text, botId) : null;
    return {
      type: 'message',
      chatId,
      senderId: typeof ev.user === 'string' ? ev.user : undefined,
      messageId: chatId && ts ? packMsgId(chatId, ts) : undefined,
      text,
      // The link may be hiding in blocks or attachments (a share card) -> serialise the whole thing into
      // an opaque text block for the core's document sources to claim.
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
        // "Open the modal" is the adapter's own job: intercept it here and call views.open, never
        // leaking it out to the core.
        if (isOpenModal(payload)) {
          void openModal(payload).catch((e) => log.warn(`Slack views.open threw: ${String(e).slice(0, 160)}`));
          return;
        }
        handlers.onCardAction(payload);
      },
      onError: (reason) => handlers.onError(reason),
      onReconnected: () => handlers.onReconnected(),
    });
    return { connect: () => channel.connect(), close: () => channel.close() };
  },

  watchedChats(): string[] {
    return watchChannels();
  },

  async listHistorySince(chatId: string, sinceMs: number): Promise<InboundMessage[]> {
    // conversations.history's `oldest` is in seconds (fractions allowed). Capped at 20 pages x 50 entries,
    // matching the Feishu side's runaway guard.
    const oldest = (Math.floor(sinceMs) / 1000).toFixed(6);
    const out: InboundMessage[] = [];
    let cursor = '';
    for (let page = 0; page < 20; page++) {
      const r = await slackApi('conversations.history', { channel: chatId, oldest, limit: 50, ...(cursor ? { cursor } : {}) });
      if (!r.ok) {
        log.warn(`Backfilling channel history failed (${chatId}): ${r.error}`);
        return out; // best-effort: return what we have, never throw
      }
      for (const m of (r.messages as Record<string, unknown>[] | undefined) ?? []) {
        const parsed = slackPort.parseMessage({ ...m, type: 'message', channel: chatId, channel_type: channelType(chatId) });
        if (parsed) out.push(parsed);
      }
      const next = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
      if (r.has_more && !next) {
        log.warn(`SLACK_PAGINATION_DRIFT: has_more=true but no next_cursor (conversations.history's pagination schema may have changed); ${chatId} ends this round early`);
      }
      if (!r.has_more || !next) break;
      cursor = next;
    }
    // Slack returns messages in **descending** time order; the core's backfill loop advances the
    // watermark in ascending order -> reverse them here.
    return out.reverse();
  },

  async probe(): Promise<InboundProbe> {
    const e = env();
    const chat = watchChannels()[0];
    if (!e.SLACK_BOT_TOKEN || !chat) return { available: false, ok: false, detail: 'Slack bot token / watched channel not fully configured (skipped)' };
    const r = await slackApi('conversations.history', { channel: chat, limit: 1 });
    const raw = JSON.stringify(r).slice(0, 400);
    if (!r.ok) {
      return {
        available: true,
        ok: false,
        kind: 'auth',
        detail: `conversations.history error=${r.error} (credentials / permissions / bot not in the channel)`,
        raw,
        authFix: SLACK_AUTH_FIX,
      };
    }
    // What is verified is exactly the envelope listHistorySince depends on: the messages array plus has_more.
    const hasMessages = Array.isArray(r.messages);
    const hasMore = typeof r.has_more === 'boolean';
    if (!hasMessages || !hasMore) {
      return { available: true, ok: false, kind: 'drift', detail: `conversations.history envelope is missing fields (messages=${hasMessages} has_more=${hasMore})`, raw };
    }
    return { available: true, ok: true, detail: 'Slack conversations.history pagination envelope intact' };
  },
};

// conversations.history entries carry **no** channel_type — fill it in, or DM history is treated as
// channel messages and hits the "nobody @-mentioned me" intake gate and is dropped: requirements sent by
// DM while offline silently vanish, and that is the sole reason backfill exists.
// Channel id prefixes are a documented Slack convention (D = im, C/G = channel / private channel; an
// mpim is treated as a channel, which is correct — it should require a mention).
// This is provider knowledge and belongs in the provider — the core only ever sees the
// provider-neutral isGroup.
function channelType(chatId: string): string {
  return chatId.startsWith('D') ? 'im' : 'channel';
}

// A mention has two forms: modern events use <@U123>, while history entries and older clients can still
// carry the display-name form <@U123|angelo>.
// Recognising only the first produces "I definitely @-mentioned it and nothing happened" at the channel
// intake gate — and that gate fails **silently** (the core conservatively ignores and leaves a single log
// line), so nothing points at the real cause. Recognising both costs one `includes`.
function mentionsBot(text: string, botId: string): boolean {
  return text.includes(`<@${botId}>`) || text.includes(`<@${botId}|`);
}

function isOpenModal(payload: Record<string, unknown>): boolean {
  if (payload.type !== 'block_actions') return false;
  const a = (payload.actions as { action_id?: string }[] | undefined)?.[0];
  return a?.action_id === OPEN_MODAL_ACTION;
}

// The "fill this in" button was clicked -> open the modal with the trigger_id. A trigger_id is valid for
// 3 seconds, so this path does no unnecessary IO whatsoever.
async function openModal(payload: Record<string, unknown>): Promise<void> {
  const triggerId = typeof payload.trigger_id === 'string' ? payload.trigger_id : '';
  const a = (payload.actions as { value?: string }[] | undefined)?.[0];
  if (!triggerId || !a?.value) return;
  let ctx: ModalContext;
  try {
    ctx = JSON.parse(a.value) as ModalContext;
  } catch {
    log.warn('Slack open modal: the button value is not valid JSON');
    return;
  }
  const spec = pendingModal(ctx) ?? degradedModal(ctx);
  // retry:false is deliberate: a trigger_id lives for only 3 seconds, so a rate-limit backoff retry buys
  // nothing but expired_trigger_id, and it buries the real failure under an error that explains nothing.
  // Better to fail once and report it faithfully.
  const r = await slackApi('views.open', { trigger_id: triggerId, view: spec }, { retry: false });
  if (!r.ok) {
    const hint =
      r.error === 'expired_trigger_id' ? ' (a trigger_id lives for only 3 seconds — do no unnecessary IO on this path)' : ` — ${explain(validateView(spec))}`;
    log.warn(`Slack views.open failed: ${r.error}${hint}`);
  }
}

// The card is still sitting in Slack but this process has restarted -> the modal's content is gone from
// memory.
// **Never fail silently** (a button that does nothing is the worst possible form): degrade to a modal
// with a single free-text field. The person can still answer, they just lose the per-question dropdowns.
// On the core side, formValues still uses the same keys (verdict/notes/assignee).
function degradedModal(ctx: ModalContext): Record<string, unknown> {
  log.warn(`Slack open modal: the form content for ${ctx.action}/${ctx.slug} is not in memory (the daemon restarted) -> degrading to a plain-text modal`);
  if (ctx.kind === 'go') {
    return buildGoModal(ctx, [], null);
  }
  return buildDecisionModal(ctx, {
    items: [],
    verdict: true,
    submitText: 'Submit',
    notesLabel: 'Additional notes',
    notesPlaceholder: 'The per-question options are unavailable after a daemon restart; please write your answer here directly',
  });
}

// Staging area for modal content: when a card is rendered, remember what the form on it should look
// like, and retrieve it when the button is clicked.
// Why this is needed: a Slack form does not live in the card, yet the open questions and the DRI pool are
// known only at render time. Keyed by slug+action, so a later render overwrites an earlier one (a new
// round's card for the same requirement should indeed replace the old one).
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
