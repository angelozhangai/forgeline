// Contract-level unit tests for the Slack adapter (matching the spec of messaging-feishu.test.ts): every
// CardBlock -> exact Block Kit, plus inbound parsing, composite message ids, the modal round trip, and
// history backfill. No network at any point: the single fetch inside slack/web.ts is replaced.
//
// Warning: what is pinned here is **our handling of Slack's payload shapes**, not Slack's actual
// behaviour. The shapes come from Slack's official documentation; "the modal really does round-trip like
// this in a real workspace, Socket Mode really does reconnect like this" needs one real integration pass
// (see the unverified list in the PR description).
process.env.FORGE_DB = ':memory:';
process.env.FORGE_FUN = '0';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { CardBlock, CardModel } from '../src/messaging/model.ts';
import type { DecisionItem } from '../src/gates/envelopes.ts';

// env must be switchable per test: the real loadConfig caches for the whole process and cannot be
// changed, and in this file's module graph only slack.ts uses it (slack/web.ts is already replaced, and
// slack/socket, slack/modal and gates/envelopes never touch config).
let slackEnv: Record<string, string | undefined> = {};
mock.module('../src/config.ts', { namedExports: { loadConfig: () => ({ env: slackEnv }) } });

interface ApiCall {
  method: string;
  body: Record<string, unknown>;
}
const calls: ApiCall[] = [];
let respond: (method: string) => Record<string, unknown> = () => ({ ok: true, ts: '1712345678.000200', channel: 'C1' });
mock.module('../src/slack/web.ts', {
  namedExports: {
    SLACK_BASE: 'https://slack.com/api',
    botToken: () => 'xoxb-test',
    appToken: () => 'xapp-test',
    slackApi: async (method: string, body: Record<string, unknown> = {}) => {
      calls.push({ method, body });
      return respond(method);
    },
  },
});
// Capture the handlers the adapter hands to Socket Mode: inbound routing (events / interactive / the
// modal interception) all runs through them.
let captured: { onEnvelope: (t: string, p: Record<string, unknown>) => void; onError: (r: string) => void; onReconnected: () => void } | null = null;
mock.module('../src/slack/socket.ts', {
  namedExports: {
    createSocketChannel: (h: typeof captured) => {
      captured = h;
      return { connect: async () => {}, close: () => {} };
    },
    backoffMs: (n: number) => 1000 * 2 ** n,
  },
});
const slack = await import('../src/messaging/slack.ts');
const { slackPort, renderSlackMessage, toMrkdwn, packMsgId, unpackMsgId, OPEN_MODAL_ACTION } = slack;

function reset(env: Record<string, string | undefined> = {}): void {
  calls.length = 0;
  respond = () => ({ ok: true, ts: '1712345678.000200', channel: 'C1' });
  slackEnv = env;
}
// Put a single block into a minimal card and take attachment.blocks (the first one or two are always the
// header plus an optional subtitle).
function blocksOf(block: CardBlock): Record<string, unknown>[] {
  const card: CardModel = { color: 'grey', title: 't', blocks: [block] };
  return (renderSlackMessage(card).attachments[0].blocks as Record<string, unknown>[]).slice(1);
}
const one = (block: CardBlock): Record<string, unknown> => blocksOf(block)[0];

// -- Envelope ----------------------------------------------------------------
test('envelope: Block Kit has no card-level colour -> the semantic colour lands on the attachment colour bar; text covers the notification preview', () => {
  const m = renderSlackMessage({ color: 'red', title: 'Requirement awaiting confirmation', subtitle: 'REQ-7', blocks: [] });
  assert.equal(m.text, 'Requirement awaiting confirmation', 'without text, the notification bar and clients that do not support blocks show nothing at all');
  assert.equal(m.attachments.length, 1);
  assert.equal((m.attachments[0] as { color: string }).color, '#e01e5a');
  const blocks = (m.attachments[0] as { blocks: Record<string, unknown>[] }).blocks;
  assert.deepEqual(blocks[0], { type: 'header', text: { type: 'plain_text', text: 'Requirement awaiting confirmation', emoji: true } });
  assert.equal(blocks[1].type, 'context', 'the subtitle goes through context (small grey text)');
});

test('envelope: no subtitle means no such block', () => {
  const blocks = (renderSlackMessage({ color: 'blue', title: 'T', blocks: [] }).attachments[0] as { blocks: unknown[] }).blocks;
  assert.equal(blocks.length, 1);
});

// -- The mrkdwn dialect ------------------------------------------------------
test('toMrkdwn: **bold** -> *bold*, [text](url) -> <url|text>, ## heading -> a bold line', () => {
  assert.equal(toMrkdwn('the **key point** is here'), 'the *key point* is here');
  assert.equal(toMrkdwn('see [the PRD](https://x.example/p)'), 'see <https://x.example/p|the PRD>');
  assert.equal(toMrkdwn('## Subheading'), '*Subheading*');
});

test('toMrkdwn: inline markup left over from the Feishu era also has to land — <font> is stripped, <at id=X> -> <@X>', () => {
  assert.equal(toMrkdwn("<font color='grey'>secondary</font> note"), 'secondary note');
  assert.equal(toMrkdwn('<at id=U123></at> take a look'), '<@U123> take a look');
});

// -- Each CardBlock -> Block Kit ---------------------------------------------
test('text / note / footnote / quote: body text goes through section, secondary information through context', () => {
  assert.deepEqual(one({ kind: 'text', md: 'hello' }), { type: 'section', text: { type: 'mrkdwn', text: 'hello' } });
  assert.equal(one({ kind: 'note', md: 'grey text' }).type, 'context');
  assert.equal(one({ kind: 'footnote', md: 'footnote' }).type, 'context');
  assert.deepEqual(one({ kind: 'quote', text: 'a short\n  summary  ' }), { type: 'section', text: { type: 'mrkdwn', text: '> a short summary' } });
});

test('callout: Block Kit body text cannot be coloured inline -> an emoji prefix carries the semantic tone', () => {
  const danger = one({ kind: 'callout', tone: 'danger', md: 'danger' }) as { text: { text: string } };
  assert.equal(danger.text.text, '🔴 *danger*');
  assert.match((one({ kind: 'callout', tone: 'warning', md: 'w' }) as { text: { text: string } }).text.text, /^🟠/);
  assert.match((one({ kind: 'callout', tone: 'info', md: 'i' }) as { text: { text: string } }).text.text, /^🔵/);
});

test('divider / stats: stats land in section.fields (Slack lays them out in two columns automatically)', () => {
  assert.deepEqual(one({ kind: 'divider' }), { type: 'divider' });
  assert.deepEqual(one({ kind: 'stats', fields: ['*Size* M', '*Confidence* 0.8'] }), {
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: '*Size* M' },
      { type: 'mrkdwn', text: '*Confidence* 0.8' },
    ],
  });
});

test('button: the core\'s {action,slug,value} goes into the button value verbatim and is usable straight from the callback', () => {
  const el = one({ kind: 'button', button: { text: 'Produce a design', style: 'primary', action: 'gateb', slug: 'refund', value: { round: 2 } } });
  const actions = el as { type: string; elements: { type: string; style?: string; value: string; text: unknown }[] };
  assert.equal(actions.type, 'actions');
  assert.equal(actions.elements[0].style, 'primary');
  assert.deepEqual(JSON.parse(actions.elements[0].value), { action: 'gateb', slug: 'refund', round: 2 });
});

test('button: the default style emits **no** style field (Slack recognises only primary/danger, and anything else fails the block)', () => {
  const el = one({ kind: 'button', button: { text: 'x', style: 'default', action: 'retry', slug: 's' } }) as { elements: Record<string, unknown>[] };
  assert.equal('style' in el.elements[0], false);
});

test('buttonRow: side-by-side buttons go into one actions block', () => {
  const el = one({
    kind: 'buttonRow',
    buttons: [
      { text: 'A', style: 'primary', action: 'gateb_force_go', slug: 's' },
      { text: 'B', style: 'default', action: 'gateb_send_back', slug: 's' },
    ],
  }) as { type: string; elements: unknown[] };
  assert.equal(el.type, 'actions');
  assert.equal(el.elements.length, 2);
});

const ITEM: DecisionItem = { id: 'H1', prompt: 'Should there be a cap?', severity: 'high', options: [{ label: 'Yes', recommended: true, impact: 'steadier risk control' }, { label: 'No' }], hint: 'Per the risk-control definition' };

test('decisionList / findingList: one block per entry, with a severity prefix and a star on the recommendation', () => {
  const list = blocksOf({ kind: 'decisionList', items: [ITEM] });
  const text = (list[0] as { text: { text: string } }).text.text;
  assert.match(text, /^\*1\.\* 🔴 \[high\] Should there be a cap\?/);
  assert.match(text, /★ Yes \(impact: steadier risk control\)/);
  assert.match(text, /_Suggestion: Per the risk-control definition_/);
  const f = blocksOf({ kind: 'findingList', findings: [{ severity: 'med', lead: 'No rollback plan', notes: [{ label: 'location', text: '§3' }] }] });
  assert.match((f[0] as { text: { text: string } }).text.text, /🟠 \[med\] No rollback plan[\s\S]*_location: §3_/);
});

// -- Forms -> modals (the one genuine interaction difference from Feishu) -----
// Input blocks are legal in a message (Slack lists the input block's surfaces as modals, messages and home
// tabs), so the form is answerable **in the card**: one click, no modal, and — the part that used to hurt —
// no form content held in process memory for a restart to lose.
test('decisionForm: the questions become input blocks in the card itself, closed by a submit button carrying the context', () => {
  reset();
  const blocks = blocksOf({
    kind: 'decisionForm',
    slug: 'refund',
    items: [ITEM],
    action: 'confirm_submit',
    round: 3,
    verdict: true,
    submitText: 'Submit answers',
    notesLabel: 'Additional notes',
    notesPlaceholder: 'Write something',
  });
  const inputs = blocks.filter((b) => b.type === 'input');
  assert.equal(inputs.length, 3, 'one per question, plus the overall verdict and the notes box');
  assert.match((inputs[0] as { block_id: string }).block_id, /^ask_/, 'keyed the same way composeDecisionAnswer reads them back');
  const last = blocks[blocks.length - 1] as { type: string; elements: { type: string; action_id: string; value: string }[] };
  assert.equal(last.type, 'actions', 'the submit button closes the form');
  assert.equal(last.elements[0].type, 'button');
  assert.deepEqual(JSON.parse(last.elements[0].value), { action: 'confirm_submit', slug: 'refund', round: 3 });
  assert.notEqual(last.elements[0].action_id, OPEN_MODAL_ACTION, 'nothing opens a modal any more');
});

test('decisionForm: a short option list becomes radio buttons (all of it visible), a long one falls back to a select', () => {
  reset();
  const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `option ${i}`, recommended: i === 0, impact: 'some impact' }));
  const form = (n: number): CardBlock => ({
    kind: 'decisionForm',
    slug: 'refund',
    items: [{ ...ITEM, options: opts(n) }],
    action: 'confirm_submit',
    round: 1,
    submitText: 'Submit',
    notesLabel: 'Notes',
    notesPlaceholder: '…',
  });
  const elOf = (b: CardBlock): { type: string; options: { description?: unknown }[] } =>
    (blocksOf(b).find((x) => x.type === 'input') as { element: { type: string; options: { description?: unknown }[] } }).element;
  const few = elOf(form(2));
  assert.equal(few.type, 'radio_buttons');
  assert.ok(few.options[0].description, "the option's impact goes on the radio button's second line rather than into its 75-character label");
  assert.equal(elOf(form(8)).type, 'static_select', 'past the radio cap a wall of options becomes a dropdown');
});

test('goForm: the DRI picker is in the card too, and its submit button carries the go action', () => {
  reset();
  const blocks = blocksOf({ kind: 'goForm', slug: 'refund', pool: ['M', 'CC'], picked: 'CC' });
  assert.equal((blocks[0] as { type: string; block_id: string }).block_id, 'assignee');
  const last = blocks[blocks.length - 1] as { type: string; elements: { value: string }[] };
  assert.equal(last.type, 'actions');
  assert.deepEqual(JSON.parse(last.elements[0].value), { action: 'go', slug: 'refund', round: 0 });
});

test('petRow: the pet\'s line goes into context; a mentionId @-mentions them (Slack\'s <@U…>)', () => {
  const el = one({ kind: 'petRow', asset: 'cat', voice: 'meow', mentionId: 'U9' }) as { type: string; elements: { text: string }[] };
  assert.equal(el.type, 'context');
  assert.equal(el.elements[0].text, '<@U9> meow');
});

// -- Composite message id ----------------------------------------------------
test('composite message id: "channel:ts" — chat.update needs two values while the port passes only one opaque string', () => {
  assert.equal(packMsgId('C1', '1712345678.000200'), 'C1:1712345678.000200');
  assert.deepEqual(unpackMsgId('C1:1712345678.000200'), { channel: 'C1', ts: '1712345678.000200' });
  assert.equal(unpackMsgId('no colon here'), null);
  assert.equal(unpackMsgId(':x'), null);
  assert.equal(unpackMsgId('C1:'), null);
});

// -- Outbound ----------------------------------------------------------------
test('replyGroupCard: a reply = posting into a thread in the same channel; returns the new card\'s composite id', async () => {
  reset();
  const id = await slackPort.replyGroupCard('C7:111.222', { color: 'blue', title: 'T', blocks: [] });
  assert.equal(calls[0].method, 'chat.postMessage');
  assert.equal(calls[0].body.channel, 'C7');
  assert.equal(calls[0].body.thread_ts, '111.222');
  assert.equal(id, 'C1:1712345678.000200');
});

test('editGroupCard: splits out channel+ts for chat.update; an unsplittable id reports false faithfully rather than silently', async () => {
  reset();
  assert.equal(await slackPort.editGroupCard('C7:111.222', { color: 'grey', title: 'T', blocks: [] }), true);
  assert.equal(calls[0].method, 'chat.update');
  assert.deepEqual([calls[0].body.channel, calls[0].body.ts], ['C7', '111.222']);
  reset();
  assert.equal(await slackPort.editGroupCard('bad-id', { color: 'grey', title: 'T', blocks: [] }), false);
  assert.equal(calls.length, 0);
});

test('an outbound failure never throws: Slack reporting ok:false -> null/false, and the caller decides how to degrade', async () => {
  reset();
  respond = () => ({ ok: false, error: 'channel_not_found' });
  assert.equal(await slackPort.sendGroupCard('C9', { color: 'grey', title: 'T', blocks: [] }), null);
  assert.equal(await slackPort.editGroupCard('C9:1.2', { color: 'grey', title: 'T', blocks: [] }), false);
});

// -- Inbound -----------------------------------------------------------------
test('parseCardAction: an ordinary button -> {action,slug,value}; operator gives who clicked', () => {
  const parsed = slackPort.parseCardAction({
    type: 'block_actions',
    user: { id: 'U42' },
    actions: [{ type: 'button', action_id: 'forge_gateb_refund', value: JSON.stringify({ action: 'gateb', slug: 'refund', round: 1 }) }],
  });
  assert.deepEqual(parsed, {
    type: 'card_action',
    action: 'gateb',
    slug: 'refund',
    value: { action: 'gateb', slug: 'refund', round: 1 },
    formValues: {},
    operatorId: 'U42',
  });
});

// The load-bearing half of inline forms. Every interaction with an input dispatches its own block_actions
// carrying the state so far — verified against a real workspace, where picking one radio option arrived as
// `radio_buttons:ask_1` with the other two questions still blank. Treating that as a submission would file a
// half-answered form the instant someone touched the first question.
test('parseCardAction: an inline form dispatches on every selection — only the button counts as a submission', () => {
  const state = {
    values: {
      ask_1: { ask_1: { type: 'radio_buttons', selected_option: { value: 'refund to balance' } } },
      notes: { notes: { type: 'plain_text_input', value: 'ship it' } },
    },
  };
  const touchingAnOption = slackPort.parseCardAction({
    type: 'block_actions',
    user: { id: 'U42' },
    state,
    actions: [{ type: 'radio_buttons', action_id: 'ask_1' }],
  });
  assert.equal(touchingAnOption, null, 'picking an option is not answering the form');

  const pressingSubmit = slackPort.parseCardAction({
    type: 'block_actions',
    user: { id: 'U42' },
    state,
    actions: [{ type: 'button', action_id: 'forge_submit_confirm_submit', value: JSON.stringify({ action: 'confirm_submit', slug: 'refund', round: 2 }) }],
  });
  assert.deepEqual(pressingSubmit, {
    type: 'card_action',
    action: 'confirm_submit',
    slug: 'refund',
    value: { action: 'confirm_submit', slug: 'refund', round: 2 },
    // The same flattener a view_submission goes through, so the core cannot tell — and never needs to —
    // whether the answer came from a card or a modal.
    formValues: { ask_1: 'refund to balance', notes: 'ship it' },
    operatorId: 'U42',
  });
});

test('parseCardAction: "open the modal" is an adapter-internal action -> the core never sees it (returns null)', () => {
  const parsed = slackPort.parseCardAction({
    type: 'block_actions',
    actions: [{ action_id: OPEN_MODAL_ACTION, value: '{"action":"go","slug":"s","kind":"go"}' }],
  });
  assert.equal(parsed, null);
});

test('parseCardAction: view_submission -> the context comes back from private_metadata and the fields are flattened out of state.values', () => {
  const parsed = slackPort.parseCardAction({
    type: 'view_submission',
    user: { id: 'U42' },
    view: {
      private_metadata: JSON.stringify({ action: 'confirm_submit', slug: 'refund', round: 2 }),
      state: {
        values: {
          ask_H1: { ask_H1: { type: 'static_select', selected_option: { value: 'Yes' } } },
          verdict: { verdict: { type: 'static_select', selected_option: { value: 'accept' } } },
          notes: { notes: { type: 'plain_text_input', value: 'Go with the risk-control definition' } },
        },
      },
    },
  });
  assert.equal(parsed?.action, 'confirm_submit');
  assert.equal(parsed?.slug, 'refund');
  assert.deepEqual(parsed?.formValues, { ask_H1: 'Yes', verdict: 'accept', notes: 'Go with the risk-control definition' });
  assert.equal(parsed?.value.round, 2);
});

test('parseCardAction: anything unrecognised returns null (bad JSON / missing slug / no private_metadata) — never guess', () => {
  assert.equal(slackPort.parseCardAction({ type: 'block_actions', actions: [{ action_id: 'x', value: 'bad json{' }] }), null);
  assert.equal(slackPort.parseCardAction({ type: 'block_actions', actions: [{ action_id: 'x', value: '{"action":"go"}' }] }), null);
  assert.equal(slackPort.parseCardAction({ type: 'view_submission', view: { private_metadata: '' } }), null);
  assert.equal(slackPort.parseCardAction({ type: 'url_verification' }), null);
});

test('parseMessage: ts (seconds.microseconds) -> milliseconds; messageId is the composite id; channel_type=im counts as a DM', () => {
  const m = slackPort.parseMessage({ event: { type: 'message', channel: 'C1', user: 'U7', ts: '1712345678.000200', text: 'take a look at this requirement', channel_type: 'im' } });
  assert.equal(m?.createTime, 1_712_345_678_000);
  assert.equal(m?.messageId, 'C1:1712345678.000200');
  assert.equal(m?.isGroup, false);
  assert.equal(m?.senderId, 'U7');
});

test('parseMessage: a missing or broken ts falls back to now(), never to 0 (a watermark at the epoch would make backfill rescan ancient history)', () => {
  const before = Date.now();
  const m = slackPort.parseMessage({ event: { type: 'message', channel: 'C1', text: 'x' } });
  assert.ok((m?.createTime ?? 0) >= before);
});

test('parseMessage: messages the bot sent itself, and anything with a subtype, never enter the pipeline (otherwise the status card would ingest itself as a requirement)', () => {
  assert.equal(slackPort.parseMessage({ event: { type: 'message', channel: 'C1', ts: '1.2', text: 'x', bot_id: 'B1' } }), null);
  assert.equal(slackPort.parseMessage({ event: { type: 'message', subtype: 'message_changed', channel: 'C1', ts: '1.2' } }), null);
  assert.equal(slackPort.parseMessage({ event: { type: 'reaction_added' } }), null);
});

test('parseMessage: channel messages detect mentions by <@BOTID> / <@BOTID|name>; with no bot user id configured -> null (the core conservatively ignores it, never treating it as "not mentioned")', () => {
  reset({ SLACK_BOT_USER_ID: 'UBOT' });
  const hit = slackPort.parseMessage({ event: { type: 'message', channel: 'C1', ts: '1.2', text: '<@UBOT> take a look', channel_type: 'channel' } });
  assert.equal(hit?.mentionedBot, true);
  // The older display-name form <@U123|name> still appears in history entries and older clients.
  // Recognising only <@U123> produces "I definitely @-mentioned it and nothing happened" at the channel
  // intake gate, and that gate fails silently (the core conservatively ignores), so nothing points at the
  // cause.
  const legacy = slackPort.parseMessage({ event: { type: 'message', channel: 'C1', ts: '1.2', text: '<@UBOT|forge> take a look', channel_type: 'channel' } });
  assert.equal(legacy?.mentionedBot, true);
  const miss = slackPort.parseMessage({ event: { type: 'message', channel: 'C1', ts: '1.2', text: 'just thinking out loud', channel_type: 'channel' } });
  assert.equal(miss?.mentionedBot, false);
  // Do not count "mentioned someone else whose id shares our prefix" as mentioning ourselves.
  const other = slackPort.parseMessage({ event: { type: 'message', channel: 'C1', ts: '1.2', text: '<@UBOTX> take a look', channel_type: 'channel' } });
  assert.equal(other?.mentionedBot, false);
  reset({});
  const noId = slackPort.parseMessage({ event: { type: 'message', channel: 'C1', ts: '1.2', text: '<@UBOT> take a look', channel_type: 'channel' } });
  assert.equal(noId?.mentionedBot, null, '"cannot be confirmed" is not the same as "nobody mentioned it"');
  assert.equal(noId?.isGroup, true);
});

test('parseMessage: the whole event is serialised into searchTexts — the link may be hiding in blocks/attachments', () => {
  const ev = { type: 'message', channel: 'C1', ts: '1.2', text: '', attachments: [{ title_link: 'https://x.feishu.cn/docx/AAA' }] };
  const m = slackPort.parseMessage({ event: ev });
  assert.deepEqual(m?.searchTexts, [JSON.stringify(ev)]);
});

// -- History backfill / probe ------------------------------------------------
test('listHistorySince: oldest is in seconds (with fractions); Slack returns descending order -> flipped to ascending for the core\'s backfill loop', async () => {
  reset();
  respond = () => ({
    ok: true,
    has_more: false,
    messages: [
      { type: 'message', user: 'U1', ts: '1712345680.000000', text: 'second' },
      { type: 'message', user: 'U1', ts: '1712345670.000000', text: 'first' },
    ],
  });
  const got = await slackPort.listHistorySince('C5', 1_712_345_600_000);
  assert.equal(calls[0].method, 'conversations.history');
  assert.equal(calls[0].body.oldest, '1712345600.000000');
  assert.deepEqual(got.map((m) => m.text), ['first', 'second']);
  assert.deepEqual(got.map((m) => m.chatId), ['C5', 'C5']);
});

test('listHistorySince: a failure never throws and returns what was already retrieved (backfill is best-effort and must not take the periodic loop down)', async () => {
  reset();
  respond = () => ({ ok: false, error: 'not_in_channel' });
  assert.deepEqual(await slackPort.listHistorySince('C5', 0), []);
});

test('probe: a missing envelope field -> drift; a failed call -> auth; all good -> ok', async () => {
  const configured = { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_WATCH_CHANNELS: 'C5' };
  reset(configured);
  respond = () => ({ ok: true, messages: [], has_more: false });
  assert.equal((await slackPort.probe()).ok, true);
  reset(configured);
  respond = () => ({ ok: true, messages: [] }); // has_more missing
  const drift = await slackPort.probe();
  assert.equal(drift.ok, false);
  assert.equal(drift.kind, 'drift');
  reset(configured);
  respond = () => ({ ok: false, error: 'not_in_channel' });
  const auth = await slackPort.probe();
  assert.equal(auth.kind, 'auth');
  // When it is not configured, say "skipped" outright rather than firing a request that is bound to fail
  // and reporting it as an auth fault.
  reset({});
  assert.deepEqual(await slackPort.probe(), { available: false, ok: false, detail: 'Slack bot token / watched channel not fully configured (skipped)' });
});

test('inboundConfigured: both the bot token and the app token are required (missing either means Socket Mode cannot connect)', () => {
  reset({ SLACK_BOT_TOKEN: 'xoxb-test' });
  assert.equal(slackPort.inboundConfigured(), false, 'no app token -> the connection cannot be established');
  reset({ SLACK_APP_TOKEN: 'xapp-test' });
  assert.equal(slackPort.inboundConfigured(), false, 'no bot token -> cards cannot be sent');
  reset({ SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' });
  assert.equal(slackPort.inboundConfigured(), true);
});

test('watchedChats: comma-separated with whitespace trimmed (backfill iteration and probe sampling share one source)', () => {
  reset({ SLACK_WATCH_CHANNELS: 'C1, C2 ,' });
  assert.deepEqual(slackPort.watchedChats(), ['C1', 'C2']);
});

test('sendDmCard: with no SLACK_DM_USER_ID configured -> send nothing, throw nothing, return false (the caller degrades on that)', async () => {
  reset({});
  assert.equal(await slackPort.sendDmCard({ color: 'grey', title: 'T', blocks: [] }), false);
  assert.equal(calls.length, 0, 'with no target, do not fire a request');
});

// -- Inbound routing (the dispatch layer inside startInbound) ----------------
function inbound(): { msgs: Record<string, unknown>[]; actions: Record<string, unknown>[]; errors: string[]; reconnects: number } {
  const msgs: Record<string, unknown>[] = [];
  const actions: Record<string, unknown>[] = [];
  const errors: string[] = [];
  let reconnects = 0;
  slackPort.startInbound({
    onMessage: (raw) => msgs.push(raw),
    onCardAction: (raw) => actions.push(raw),
    onError: (r) => errors.push(r),
    onReconnected: () => {
      reconnects++;
    },
  });
  const box = { msgs, actions, errors, reconnects: 0 };
  Object.defineProperty(box, 'reconnects', { get: () => reconnects });
  return box;
}

test('inbound routing: events_api -> onMessage, interactive -> onCardAction, other envelopes are dropped', () => {
  reset();
  const box = inbound();
  captured?.onEnvelope('events_api', { event: { type: 'message' } });
  captured?.onEnvelope('interactive', { type: 'block_actions', actions: [{ action_id: 'x', value: '{}' }] });
  captured?.onEnvelope('slash_commands', { command: '/forge' }); // slash commands are not subscribed -> must not leak to the core
  assert.equal(box.msgs.length, 1);
  assert.equal(box.actions.length, 1);
});

test('inbound routing: the connection\'s error / reconnected pass through to the core verbatim (markWs liveness and the reconnect backfill both depend on them)', () => {
  reset();
  const box = inbound();
  captured?.onError('WebSocket closed code=1006');
  captured?.onReconnected();
  assert.deepEqual(box.errors, ['WebSocket closed code=1006']);
  assert.equal(box.reconnects, 1);
});

// Nothing renders a modal-opening button any more, but cards posted before forms moved into the card are
// still sitting in Slack with one on them. Clicking it must still do something — a button that dies on
// upgrade is the same failure as a button that never worked.
test('inbound routing: a modal button from an older card is still intercepted by the adapter — the core receives nothing, and views.open really is called', async () => {
  reset();
  const box = inbound();
  captured?.onEnvelope('interactive', {
    type: 'block_actions',
    trigger_id: 'T123',
    actions: [{ action_id: OPEN_MODAL_ACTION, value: JSON.stringify({ action: 'go', slug: 'refund', kind: 'go' }) }],
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(box.actions, [], 'opening a modal is adapter-internal; the core never sees it');
  assert.equal(calls[0]?.method, 'views.open');
  assert.equal(calls[0]?.body.trigger_id, 'T123');
  const view = calls[0]?.body.view as { private_metadata: string; blocks: { block_id?: string; element: { type: string } }[] };
  assert.deepEqual(JSON.parse(view.private_metadata), { action: 'go', slug: 'refund', round: 0 }, 'the context is intact, so the answer lands on the right requirement');
  assert.equal(view.blocks[0].element.type, 'plain_text_input', 'the DRI pool was never written into that old card, so it degrades to free text rather than guessing');
});

test('opening a modal: an older card whose questions were never in it -> a plain-text modal, never a button that does nothing', async () => {
  reset();
  const box = inbound();
  captured?.onEnvelope('interactive', {
    type: 'block_actions',
    trigger_id: 'T9',
    actions: [{ action_id: OPEN_MODAL_ACTION, value: JSON.stringify({ action: 'confirm_submit', slug: 'gone', round: 2, kind: 'decision' }) }],
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(box.actions.length, 0);
  assert.equal(calls[0]?.method, 'views.open');
  const view = calls[0]?.body.view as { private_metadata: string; blocks: { block_id?: string }[] };
  // The context is still complete — an answer written in the degraded modal still lands on the right
  // requirement
  assert.deepEqual(JSON.parse(view.private_metadata), { action: 'confirm_submit', slug: 'gone', round: 2 });
  assert.deepEqual(view.blocks.map((b) => b.block_id), ['verdict', 'notes']);
});

test('opening a modal: a missing trigger_id / a value that is not JSON -> no request is fired, and nothing crashes', async () => {
  reset();
  inbound();
  captured?.onEnvelope('interactive', { type: 'block_actions', actions: [{ action_id: OPEN_MODAL_ACTION, value: '{}' }] }); // no trigger_id
  captured?.onEnvelope('interactive', { type: 'block_actions', trigger_id: 'T', actions: [{ action_id: OPEN_MODAL_ACTION, value: 'bad json{' }] });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 0);
});

// -- The channel webhook fallback --------------------------------------------
test('postWebhook: with no URL configured -> false and no request; configured -> POST the same rendered result', async () => {
  reset({});
  assert.equal(await slackPort.postWebhook('Title', ['one line'], 'blue'), false);

  reset({ SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X' });
  const origFetch = globalThis.fetch;
  let hit: { url: string; body: unknown } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    hit = { url: String(url), body: JSON.parse(init.body as string) };
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;
  try {
    assert.equal(await slackPort.postWebhook('Title', ['one line'], 'blue'), true);
    assert.equal(hit?.url, 'https://hooks.slack.com/services/T/B/X');
    assert.equal((hit?.body as { text: string }).text, 'Title');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('postWebhook: a network error is swallowed and returns false (a fallback channel failing must not topple the caller)', async () => {
  reset({ SLACK_WEBHOOK_URL: 'https://hooks.slack.com/x' });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('ECONNRESET');
  }) as typeof fetch;
  try {
    assert.equal(await slackPort.postWebhook('t', [], 'red'), false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('sendDmText: a simple text card reuses the same render path (no second look to maintain)', async () => {
  reset({ SLACK_DM_USER_ID: 'U1' });
  assert.equal(await slackPort.sendDmText('Drift alert', ['a', 'b'], 'orange'), true);
  const att = (calls[0].body.attachments as { color: string; blocks: { type: string }[] }[])[0];
  assert.equal(att.color, '#e8912d');
  assert.deepEqual(att.blocks.map((b) => b.type), ['header', 'section', 'section']);
});
