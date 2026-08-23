// Contract-level unit tests for the Feishu adapter's renderer and inbound parsing: every CardBlock ->
// exact Feishu card 2.0 JSON.
// This is the regression base of the thin transport seam — the rendered shape of each CardModel semantic
// block is pinned, so a future change to the model cannot silently drift the Feishu JSON.
process.env.FORGE_FUN = '0'; // turn the easter eggs off: petRow attaches no animation, making the render deterministic (no image_key dependency)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardModel, CardBlock } from '../src/messaging/model.ts';
import type { DecisionItem } from '../src/gates/envelopes.ts';
// Dynamic import: ensures FORGE_FUN=0 takes effect before feishu.ts -> util/pet.ts is evaluated (a static
// import would be hoisted by ESM above the env assignment).
const { renderFeishuCard, feishuPort } = await import('../src/messaging/feishu.ts');
const { __setBotOpenIdCacheForTest } = await import('../src/feishu/dm.ts');
// Used by the channel intake gate to detect mentions: pin the bot open_id so parseMessage can compare
// synchronously (bypassing the env file key and the bot/v3/info request).
__setBotOpenIdCacheForTest('ou_bot');

// Put a single block into a minimal card and pull body.elements out to assert on.
function els(block: CardBlock): unknown[] {
  const card: CardModel = { color: 'grey', title: 't', blocks: [block] };
  return (renderFeishuCard(card).body as { elements: unknown[] }).elements;
}
const one = (block: CardBlock): unknown => els(block)[0];

test('envelope: color -> template, title, and a subtitle key only when non-empty', () => {
  const withSub = renderFeishuCard({ color: 'red', title: 'T', subtitle: 'S', blocks: [] });
  assert.deepEqual(withSub, {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { template: 'red', title: { tag: 'plain_text', content: 'T' }, subtitle: { tag: 'plain_text', content: 'S' } },
    body: { elements: [] },
  });
  const noSub = renderFeishuCard({ color: 'blue', title: 'T', blocks: [] }) as { header: Record<string, unknown> };
  assert.equal('subtitle' in noSub.header, false); // an empty subtitle emits no key
});

test('text / note / footnote / quote: the exact wrapping of prose blocks', () => {
  assert.deepEqual(one({ kind: 'text', md: 'hello' }), { tag: 'markdown', content: 'hello' });
  assert.deepEqual(one({ kind: 'note', md: 'grey text' }), { tag: 'markdown', content: "<font color='grey'>grey text</font>" });
  assert.deepEqual(one({ kind: 'footnote', md: 'footnote' }), { tag: 'markdown', text_size: 'notation', content: "<font color='grey'>footnote</font>" });
  // quote collapses internal newlines and whitespace into a single line
  assert.deepEqual(one({ kind: 'quote', text: 'a short\n  summary  ' }), { tag: 'markdown', content: '> a short summary' });
});

test('callout: the whole paragraph is wrapped in the semantic tone (danger -> red), and the core no longer holds <font>', () => {
  assert.deepEqual(one({ kind: 'callout', tone: 'danger', md: '🔁 **Re-review round 2** — note' }), { tag: 'markdown', content: "<font color='red'>🔁 **Re-review round 2** — note</font>" });
  assert.match(JSON.stringify(one({ kind: 'callout', tone: 'warning', md: 'x' })), /<font color='orange'>x<\/font>/);
  assert.match(JSON.stringify(one({ kind: 'callout', tone: 'info', md: 'x' })), /<font color='blue'>x<\/font>/);
});

test('divider -> hr; stats -> column_set of weighted field columns', () => {
  assert.deepEqual(one({ kind: 'divider' }), { tag: 'hr' });
  assert.deepEqual(one({ kind: 'stats', fields: ['**A**\n1', '**B**\n2'] }), {
    tag: 'column_set',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: '**A**\n1' }] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: '**B**\n2' }] },
    ],
  });
});

test('button: a callback button whose value is {action,slug,...extra} (in a fixed order)', () => {
  assert.deepEqual(one({ kind: 'button', button: { text: 'Retry', style: 'primary', action: 'retry', slug: 'foo' } }), {
    tag: 'button',
    text: { tag: 'plain_text', content: 'Retry' },
    type: 'primary',
    behaviors: [{ type: 'callback', value: { action: 'retry', slug: 'foo' } }],
  });
  // with a passed-through value (such as round)
  const b = one({ kind: 'button', button: { text: 'Revise again', style: 'default', action: 'gateb_send_back', slug: 'foo', value: { round: 3 } } });
  assert.equal(JSON.stringify(b).includes('"value":{"action":"gateb_send_back","slug":"foo","round":3}'), true);
});

test('buttonRow -> column_set, one weighted column per button', () => {
  const row = one({
    kind: 'buttonRow',
    buttons: [
      { text: 'A', style: 'primary', action: 'go', slug: 's' },
      { text: 'B', style: 'default', action: 'no', slug: 's' },
    ],
  }) as { tag: string; columns: { elements: { type: string }[] }[] };
  assert.equal(row.tag, 'column_set');
  assert.equal(row.columns.length, 2);
  assert.equal(row.columns[0].elements[0].type, 'primary');
  assert.equal(row.columns[1].elements[0].type, 'default');
});

const di = (prompt: string, options: DecisionItem['options'], severity = 'med', hint = ''): DecisionItem => ({ prompt, options, severity, hint });

test('decisionList: one markdown line per item, with a star on the recommendation, the impact as a sub-line, a coloured severity, and the hint', () => {
  const items = [di('Should it expire?', [{ label: 'Never expire', recommended: true, impact: 'friendlier to users' }, { label: 'One year', recommended: false, impact: '' }], 'high', 'lean towards never expiring')];
  const md = JSON.stringify(els({ kind: 'decisionList', items }));
  assert.match(md, /\*\*1\.\*\*/);
  assert.match(md, /<font color='red'>\[high\]<\/font>/); // severity colouring lives in the adapter
  assert.match(md, /★ Never expire \(impact: friendlier to users\)/);
  assert.match(md, /<font color='grey'>Suggestion: lean towards never expiring<\/font>/);
});

test('findingList: numbering + severity label + grey location/suggestion sub-lines (omitted when absent)', () => {
  const out = JSON.stringify(
    els({ kind: 'findingList', findings: [
      { severity: 'high', lead: 'Missing idempotency key', notes: [{ label: 'location', text: 'acceptance' }, { label: 'suggestion', text: 'add a unique key' }] },
      { severity: 'low', lead: 'Minor naming issue' }, // no notes
    ] }),
  );
  assert.match(out, /\*\*1\.\*\* <font color='red'>\[high\]<\/font> Missing idempotency key/);
  assert.match(out, /<font color='grey'>location: acceptance<\/font>/);
  assert.match(out, /<font color='grey'>suggestion: add a unique key<\/font>/);
  assert.match(out, /\*\*2\.\*\* <font color='grey'>\[low\]<\/font> Minor naming issue/);
  assert.doesNotMatch(out, /\*\*2\.\*\*[\s\S]*location/); // the second finding has no sub-lines ([\s\S] = any character including newlines)
});

test('decisionForm: a select_static(ask_H{n}) per item + an "other" fallback + verdict + notes + submit (value order action,round,slug)', () => {
  const items = [di('Q1', [{ label: 'Alpha', recommended: true, impact: '' }]), di('Q2', [{ label: 'Beta', recommended: false, impact: '' }])];
  const form = one({ kind: 'decisionForm', slug: 'foo', items, action: 'confirm_submit', round: 2, verdict: true, submitText: 'Submit', notesLabel: 'Notes', notesPlaceholder: 'ph' });
  const s = JSON.stringify(form);
  assert.match(s, /"name":"ask_H1"/);
  assert.match(s, /"name":"ask_H2"/);
  assert.match(s, /"value":"__other__"/); // the "other" fallback option
  assert.match(s, /"name":"verdict"/);
  assert.match(s, /"name":"notes"/);
  assert.match(s, /"value":\{"action":"confirm_submit","round":2,"slug":"foo"\}/); // round passed through, order pinned (stops the SDK from de-duplicating it away)
});

test('decisionForm: verdict=false emits no overall-verdict dropdown; an item with no options emits no select', () => {
  const items = [di('Question with no options', [])];
  const s = JSON.stringify(one({ kind: 'decisionForm', slug: 'foo', items, action: 'gateb_answer_submit', round: 0, submitText: 'Submit', notesLabel: 'L', notesPlaceholder: 'P' }));
  assert.doesNotMatch(s, /"name":"verdict"/);
  assert.doesNotMatch(s, /"tag":"select_static"/); // no options -> no dropdown
  assert.match(s, /"name":"notes"/);
});

test('goForm: a DRI dropdown (with the recommendation as initial_option) plus a go submit', () => {
  const withPick = JSON.stringify(one({ kind: 'goForm', slug: 'foo', pool: ['EO', 'CC'], picked: 'EO' }));
  assert.match(withPick, /"initial_option":"EO"/);
  assert.match(withPick, /"value":\{"action":"go","slug":"foo"\}/);
  // a pick that is not in the pool -> no initial_option (do not let a stale person slip through)
  assert.doesNotMatch(JSON.stringify(one({ kind: 'goForm', slug: 'foo', pool: ['EO'], picked: 'ZZ' })), /"initial_option"/);
});

test('petRow: setting mentionId prefixes an <at>; with FUN off it degrades to plain markdown text', () => {
  // FORGE_FUN=0 -> no animation, so petRow degrades to md(content)
  assert.deepEqual(one({ kind: 'petRow', asset: 'egg', voice: 'reviewing…' }), { tag: 'markdown', content: 'reviewing…' });
  assert.deepEqual(one({ kind: 'petRow', asset: 'egg', voice: 'waiting on your call', mentionId: 'ou_pm' }), { tag: 'markdown', content: '<at id=ou_pm></at> waiting on your call' });
});

// -- Inbound parsing ---------------------------------------------------------
test('parseCardAction: digs out action/slug/value + form_value; a missing action or slug -> null', () => {
  const raw = {
    action: { value: { action: 'confirm_submit', slug: 'foo', round: 1 } },
    raw: { event: { action: { form_value: { verdict: 'accept', notes: 'x', ask_H1: 'Alpha' } }, operator: { open_id: 'ou_m' } } },
  };
  const a = feishuPort.parseCardAction(raw);
  assert.ok(a);
  assert.equal(a.action, 'confirm_submit');
  assert.equal(a.slug, 'foo');
  assert.deepEqual(a.value, { action: 'confirm_submit', slug: 'foo', round: 1 });
  assert.deepEqual(a.formValues, { verdict: 'accept', notes: 'x', ask_H1: 'Alpha' });
  assert.equal(a.operatorId, 'ou_m');
  // missing slug -> unrecognised
  assert.equal(feishuPort.parseCardAction({ action: { value: { action: 'go' } } }), null);
  assert.equal(feishuPort.parseCardAction({}), null);
});

test('parseMessage: plain text comes from message.content.text; searchTexts falls back to the whole event (preserving link extraction from rich text and share cards)', () => {
  // Rich text / a document share card: plain text yields no link, but the link is inside the event JSON ->
  // searchTexts still surfaces it
  const shareUrl = 'https://x.feishu.cn/docx/abc123';
  const raw = {
    chatId: 'oc_1',
    senderId: 'ou_pm',
    messageId: 'om_1',
    createTime: '1700000000000',
    text: '',
    raw: { event: { message: { content: JSON.stringify({ title: 'requirement', href: shareUrl }) } } },
  };
  const m = feishuPort.parseMessage(raw);
  assert.ok(m);
  assert.equal(m.chatId, 'oc_1');
  assert.equal(m.senderId, 'ou_pm');
  assert.equal(m.messageId, 'om_1');
  assert.equal(m.createTime, 1700000000000);
  assert.equal(Array.isArray(m.searchTexts), true);
  assert.equal(m.searchTexts![0].includes(shareUrl), true); // the share card's link lands among the candidates, so the core can extract it
});

test('parseMessage: a plain-text URL comes straight through in text', () => {
  const m = feishuPort.parseMessage({ chatId: 'oc', text: 'take a look at https://x.feishu.cn/docx/zzz', createTime: 1 });
  assert.ok(m);
  assert.match(m.text, /docx\/zzz/);
});

test('parseMessage: a missing or broken createTime falls back to now() (never 0, which would set the watermark to the epoch and make backfill rescan history)', () => {
  const before = Date.now();
  const m = feishuPort.parseMessage({ chatId: 'oc', text: 'x' }); // no createTime
  const after = Date.now();
  assert.ok(m);
  assert.ok(m.createTime >= before && m.createTime <= after, `createTime=${m.createTime} should fall in the window around the call [${before},${after}], not be 0`);
  assert.notEqual(m.createTime, 0);
});

test('parseMessage: a channel message mentioning this bot -> isGroup=true, mentionedBot=true (read from the server-populated mentions, not from normalising the body)', () => {
  const m = feishuPort.parseMessage({
    chatId: 'oc_g',
    text: '@bot take a look at this requirement https://x.feishu.cn/docx/abc',
    createTime: 1,
    raw: { event: { message: { chat_type: 'group', mentions: [{ id: { open_id: 'ou_bot' } }] } } },
  });
  assert.ok(m);
  assert.equal(m.isGroup, true);
  assert.equal(m.mentionedBot, true);
});

test('parseMessage: a channel message mentioning only other people -> mentionedBot=false (the core ignores it on that basis)', () => {
  const m = feishuPort.parseMessage({
    chatId: 'oc_g',
    text: 'just sharing https://x.feishu.cn/docx/abc',
    createTime: 1,
    raw: { event: { message: { chat_type: 'group', mentions: [{ id: { open_id: 'ou_other' } }] } } },
  });
  assert.ok(m);
  assert.equal(m.isGroup, true);
  assert.equal(m.mentionedBot, false);
});

test('parseMessage: a p2p DM -> isGroup=false (the core requires no mention for it to enter the pipeline)', () => {
  const m = feishuPort.parseMessage({
    chatId: 'oc_p',
    text: 'sending a requirement by DM https://x.feishu.cn/docx/abc',
    createTime: 1,
    raw: { event: { message: { chat_type: 'p2p' } } },
  });
  assert.ok(m);
  assert.equal(m.isGroup, false);
});
