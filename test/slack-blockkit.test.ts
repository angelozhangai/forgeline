// The Block Kit **structural gate**: moving the class of trap that "only surfaces when someone clicks
// once in a real workspace" into CI.
//
// These traps all have the same shape: Slack replies `ok:false / invalid_blocks` **without saying which
// block or which field**, so what a person sees is "the card never showed up" or "the button does
// nothing", with a single warning in the log. Half the reason issue #14's acceptance checklist wanted a
// real workspace was to catch exactly these — and they are in fact all **structural** problems, decidable
// locally.
//
// So this file does two things:
//  1. Pins the validator itself, rule by rule (each rule must genuinely catch its violation — otherwise
//     it is just an ornament that always returns an empty array);
//  2. Runs it against **every card and every modal Forge can emit**, including **adversarial content**
//     (an emoji sitting on a boundary, empty strings, overlong text). That is the real acceptance: not
//     "we got it right once" but "no card can ever produce this error".
process.env.FORGE_DB = ':memory:';
process.env.FORGE_FUN = '0';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BK_LIMIT, explain, validateAttachments, validateBlocks, validateView } from '../src/slack/blockkit.ts';
import { buildDecisionModal, buildGoModal } from '../src/slack/modal.ts';
import { renderSlackMessage } from '../src/messaging/slack.ts';
import { buildCard, buildStatusCard, type NotifyKind } from '../src/notify.ts';
import { STATES } from '../src/statemachine/states.ts';
import type { CardBlock, CardModel } from '../src/messaging/model.ts';
import type { DecisionItem } from '../src/gates/envelopes.ts';
import type { Session } from '../src/types.ts';

// -- 1. The validator itself -------------------------------------------------
// Every rule gets a payload that genuinely violates it. Without this layer, the validator could return an
// empty array forever and nobody would notice.

const okSection = { type: 'section', text: { type: 'mrkdwn', text: 'hi' } };

test('validator: a valid payload returns an empty array (it must not be an ornament that only ever says OK — every case below really catches something)', () => {
  assert.deepEqual(validateBlocks([{ type: 'header', text: { type: 'plain_text', text: 't' } }, okSection, { type: 'divider' }]), []);
});

test('validator: empty text — Slack does not accept an empty plain_text/mrkdwn, and the whole payload is rejected', () => {
  const p = validateBlocks([{ type: 'section', text: { type: 'mrkdwn', text: '' } }]);
  assert.equal(p.length, 1);
  assert.match(p[0], /text is empty/);
});

test('validator: over the limit — limits are per field (header 150 / section 3000 / button 75)', () => {
  assert.match(validateBlocks([{ type: 'header', text: { type: 'plain_text', text: 'x'.repeat(151) } }])[0], /exceeds the limit \(151 > 150\)/);
  assert.match(validateBlocks([{ type: 'section', text: { type: 'mrkdwn', text: 'x'.repeat(3001) } }])[0], /exceeds the limit \(3001 > 3000\)/);
});

test('validator: a lone surrogate — an emoji cut in half means Slack receives invalid UTF-16 and rejects the whole payload', () => {
  const half = `${'x'.repeat(4)}🚀`.slice(0, 5); // keep only the first half of the surrogate pair
  assert.match(validateBlocks([{ type: 'section', text: { type: 'mrkdwn', text: half } }])[0], /lone surrogate/);
});

test('validator: an empty actions.elements — the unforeseen consequence of "one button fewer" is that the whole message is rejected', () => {
  assert.match(validateBlocks([{ type: 'actions', elements: [] }])[0], /at least one element/);
});

test('validator: an empty section.fields / empty context.elements are equally invalid', () => {
  assert.match(validateBlocks([{ type: 'section', fields: [] }])[0], /empty array/);
  assert.match(validateBlocks([{ type: 'context', elements: [] }])[0], /elements: empty/);
});

test('validator: a button value over 2000, a duplicate action_id, and a style that is not primary/danger — all three get the whole payload rejected', () => {
  const btn = (extra: Record<string, unknown>) => ({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'b' }, action_id: 'a1', ...extra }] });
  assert.match(validateBlocks([btn({ value: 'v'.repeat(2001) })])[0], /value: exceeds the limit/);
  assert.match(validateBlocks([btn({ style: 'default' })])[0], /only primary\/danger/);
  assert.match(validateBlocks([btn({}), btn({})]).join(''), /duplicate action_id "a1"/);
});

test('validator: block count limits — 50 per message, 100 per modal (going over is not "the tail is gone" but the whole payload rejected)', () => {
  const many = Array.from({ length: 51 }, () => okSection);
  assert.match(validateBlocks(many)[0], /too many blocks \(51 > 50\)/);
  assert.deepEqual(validateBlocks(many, { max: BK_LIMIT.blocksPerView }), []);
});

test('validator: an empty block list / a non-array — say so faithfully, never treat it as valid', () => {
  assert.match(validateBlocks([])[0], /empty/);
  assert.match(validateBlocks(null)[0], /not an array/);
});

test('validator: the modal trio (title/submit/close) caps at 24; private_metadata caps at 3000', () => {
  const view = (extra: Record<string, unknown>) => ({ type: 'modal', title: { type: 'plain_text', text: 't' }, blocks: [okSection], ...extra });
  assert.match(validateView(view({ submit: { type: 'plain_text', text: 'x'.repeat(25) } }))[0], /view\.submit: text exceeds the limit/);
  assert.match(validateView(view({ private_metadata: 'x'.repeat(3001) }))[0], /private_metadata: exceeds the limit/);
  assert.deepEqual(validateView(view({})), []);
});

test('validator: an attachment colour bar must be #rrggbb (Slack does not recognise template colour names)', () => {
  assert.match(validateAttachments([{ color: 'red', blocks: [okSection] }])[0], /should be #rrggbb/);
  assert.deepEqual(validateAttachments([{ color: '#2eb886', blocks: [okSection] }]), []);
});

test('explain: when the structure is fine it says so — "most likely permissions, the channel, or credentials" — rather than sending someone hunting through the payload', () => {
  assert.match(explain([]), /most likely permissions, the channel, or credentials/);
  assert.match(explain(['a', 'b']), /structural self-check: a; b/);
});

// -- 2. Run against every card Forge can really emit --------------------------

function sess(p: Partial<Session> = {}): Session {
  return {
    id: 'id1',
    slug: 'finance-report',
    title: 'Automate the monthly finance report',
    state: 'AWAITING_GO',
    branch: 'dev',
    gate_a_output_path: null,
    routing: null,
    adversarial_residual: null,
    gate_a_cost_usd: 1,
    gate_b_cost_usd: 2,
    confirmed_by: null,
    confirmed_notes: null,
    error: null,
    prd_url: null,
    ...p,
  } as unknown as Session;
}

const KINDS: NotifyKind[] = [
  'needs_confirm',
  'needs_arbitration',
  'needs_gateb',
  'needs_gateb_input',
  'needs_gateb_arbitration',
  'needs_go',
  'needs_review_pr',
  'needs_gatec_input',
  'needs_gatec_arbitration',
  'needs_gated_input',
  'needs_gated_arbitration',
  'needs_merge',
  'failed',
  'done',
  'recovered',
];

const bad = (card: CardModel): string[] => validateAttachments(renderSlackMessage(card).attachments);

test('every DM card (one per NotifyKind) renders structurally valid Block Kit', () => {
  const offenders: string[] = [];
  for (const kind of KINDS) {
    const problems = bad(buildCard(kind, sess({ error: 'something broke' }), { stage: 'Gate B', error: 'boom', issues: [{ repo: 'api', number: 7, url: 'https://x/7' }], from: 'A', to: 'B' }));
    if (problems.length) offenders.push(`${kind}: ${problems.join('; ')}`);
  }
  assert.deepEqual(offenders, []);
});

test('every channel status card (one per State) renders structurally valid Block Kit', () => {
  const offenders: string[] = [];
  for (const state of STATES) {
    const problems = bad(buildStatusCard(sess({ state }), { stage: 'Gate C', error: 'boom' }));
    if (problems.length) offenders.push(`${state}: ${problems.join('; ')}`);
  }
  assert.deepEqual(offenders, []);
});

// Adversarial content: an emoji sitting exactly on each cap boundary (so the truncation point splits the
// surrogate pair), plus empty strings and overlong text.
const EDGE = (n: number): string => `${'a'.repeat(n - 1)}🚀${'z'.repeat(50)}`;
const items = (n: number): DecisionItem[] =>
  Array.from({ length: n }, (_, i) => ({
    prompt: EDGE(BK_LIMIT.inputLabel),
    severity: 'high',
    hint: EDGE(BK_LIMIT.inputLabel),
    options: [{ label: EDGE(BK_LIMIT.optionText), recommended: i === 0, impact: 'large' }],
  })) as unknown as DecisionItem[];

test('adversarial content: the truncation point lands on an emoji / empty strings / overlong text — the whole card is still structurally valid', () => {
  const blocks: CardBlock[] = [
    { kind: 'text', md: EDGE(BK_LIMIT.sectionText) },
    { kind: 'text', md: '' },
    { kind: 'note', md: '' },
    { kind: 'footnote', md: EDGE(BK_LIMIT.contextText) },
    { kind: 'quote', text: '  \n  ' },
    { kind: 'callout', tone: 'danger', md: '' },
    { kind: 'divider' },
    { kind: 'stats', fields: [] },
    { kind: 'stats', fields: [EDGE(BK_LIMIT.fieldText), '', 'ok'] },
    { kind: 'buttonRow', buttons: [] },
    { kind: 'button', button: { text: EDGE(BK_LIMIT.buttonText), style: 'default', action: 'go', slug: 's', value: { blob: 'x'.repeat(3000) } } },
    { kind: 'decisionList', items: items(3) },
    { kind: 'findingList', findings: [{ severity: 'high', lead: EDGE(BK_LIMIT.sectionText), notes: [{ label: 'location', text: '' }] }] },
    { kind: 'petRow', asset: 'a', voice: '' },
    { kind: 'goForm', slug: 's', pool: [], picked: null },
  ];
  assert.deepEqual(bad({ color: 'red', title: EDGE(BK_LIMIT.headerText), subtitle: '', blocks }), []);
});

test('an empty title still sends: neither the header nor the notification text may be empty (empty = the whole payload rejected, and the card simply disappears)', () => {
  const out = renderSlackMessage({ color: 'grey', title: '   ', blocks: [] });
  assert.equal(out.text, 'Forge');
  assert.deepEqual(validateAttachments(out.attachments), []);
  assert.notEqual(((out.attachments[0].blocks as Record<string, unknown>[])[0] as { text: { text: string } }).text.text, '');
});

test('a button value over 2000 keeps only {action,slug} — never truncate into JSON that cannot be parsed back', () => {
  const card: CardModel = { color: 'blue', title: 't', blocks: [{ kind: 'button', button: { text: 'go', style: 'primary', action: 'go', slug: 'finance-report', value: { blob: 'x'.repeat(3000) } } }] };
  const el = ((card && renderSlackMessage(card).attachments[0].blocks) as Record<string, unknown>[])[1] as { elements: { value: string }[] };
  assert.deepEqual(JSON.parse(el.elements[0].value), { action: 'go', slug: 'finance-report' });
  assert.deepEqual(bad(card), []);
});

// -- Modals ------------------------------------------------------------------

test('every modal shape (with/without open questions, with/without an overall verdict, with/without a DRI pool) is a valid view', () => {
  const ctx = { action: 'confirm_submit', slug: 'finance-report', round: 2, kind: 'decision' as const };
  const o = { submitText: EDGE(BK_LIMIT.viewChip), notesLabel: EDGE(BK_LIMIT.inputLabel), notesPlaceholder: EDGE(BK_LIMIT.placeholder), title: '' };
  assert.deepEqual(validateView(buildDecisionModal(ctx, { items: items(12), verdict: true, ...o })), []);
  assert.deepEqual(validateView(buildDecisionModal(ctx, { items: [], verdict: false, ...o })), []);
  const go = { action: 'go', slug: 'finance-report', kind: 'go' as const };
  assert.deepEqual(validateView(buildGoModal(go, ['M', 'EO', EDGE(BK_LIMIT.optionValue)], 'EO')), []);
  assert.deepEqual(validateView(buildGoModal(go, [], null)), []);
});
