// The modal round trip (src/slack/modal.ts) — the one genuine interaction difference between Slack and
// Feishu.
// It rests on a single bet: **the context survives via private_metadata**, and every field arrives at
// once via state.values. This file joins both ends of the round trip and runs them (build -> simulated
// submit -> parse), with payload shapes taken from Slack's official documentation.
//
// Warning: what is pinned here is our handling, not Slack's actual behaviour — an integration pass
// against a real workspace remains on the unverified list in the PR.
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionModal, buildGoModal, flattenStateValues, parseViewSubmission, type ModalContext } from '../src/slack/modal.ts';
import type { DecisionItem } from '../src/gates/envelopes.ts';

const ITEMS: DecisionItem[] = [
  { id: 'H1', prompt: 'Should there be a cap?', severity: 'high', options: [{ label: 'Yes', recommended: true }, { label: 'No' }], hint: 'Per the risk-control definition' },
  { id: 'H2', prompt: 'When does it ship?', options: [{ label: 'This week' }, { label: 'Next week' }] },
];
const CTX: ModalContext = { action: 'confirm_submit', slug: 'refund', round: 3, kind: 'decision' };

// Simulate a Slack submission: pack what the user filled in for each input block into state.values'
// two-level structure.
function submit(view: Record<string, unknown>, filled: Record<string, string>): Record<string, unknown> {
  const values: Record<string, Record<string, unknown>> = {};
  for (const b of view.blocks as { type: string; block_id?: string; element?: { type: string; action_id: string } }[]) {
    if (b.type !== 'input' || !b.block_id || !b.element) continue;
    const v = filled[b.block_id];
    const el = b.element.type === 'plain_text_input' ? { type: 'plain_text_input', value: v ?? null } : { type: 'static_select', selected_option: v === undefined ? null : { value: v } };
    values[b.block_id] = { [b.element.action_id]: el };
  }
  return { type: 'view_submission', user: { id: 'U42' }, view: { private_metadata: view.private_metadata, state: { values } } };
}

test('decision modal: one input block per open question, with block_id/action_id both ask_<id> (lined up with the reassembly, so answers can never be attached to the wrong question)', () => {
  const v = buildDecisionModal(CTX, { items: ITEMS, verdict: true, submitText: 'Submit answers', notesLabel: 'Additional notes', notesPlaceholder: 'Write something' });
  const ids = (v.blocks as { block_id?: string }[]).map((b) => b.block_id);
  assert.deepEqual(ids, ['ask_H1', 'ask_H2', 'verdict', 'notes']);
  assert.equal(v.type, 'modal');
  assert.equal((v.submit as { text: string }).text, 'Submit answers');
});

test('decision modal: options carry a star on the recommendation plus an "other" fallback; the hint lands in the hint field', () => {
  const v = buildDecisionModal(CTX, { items: ITEMS, submitText: 's', notesLabel: 'n', notesPlaceholder: 'p' });
  const first = (v.blocks as Record<string, unknown>[])[0] as { element: { options: { text: { text: string }; value: string }[] }; hint?: { text: string } };
  assert.deepEqual(first.element.options.map((o) => o.text.text), ['★ Yes', 'No', 'Other (write it in the notes below)']);
  assert.equal(first.element.options[2].value, '__other__');
  assert.match(first.hint?.text ?? '', /Per the risk-control definition/);
});

test('decision modal: every item is optional — the PM may answer only some and write the rest in the notes box (matching the Feishu semantics)', () => {
  const v = buildDecisionModal(CTX, { items: ITEMS, verdict: true, submitText: 's', notesLabel: 'n', notesPlaceholder: 'p' });
  for (const b of v.blocks as { type: string; optional?: boolean }[]) {
    if (b.type === 'input') assert.equal(b.optional, true);
  }
});

test('round trip: {action,slug,round} come back verbatim through private_metadata and every field arrives at once (this is the bet this phase rests on)', () => {
  const v = buildDecisionModal(CTX, { items: ITEMS, verdict: true, submitText: 's', notesLabel: 'n', notesPlaceholder: 'p' });
  const payload = submit(v, { ask_H1: 'Yes', ask_H2: 'Next week', verdict: 'accept', notes: 'Go with the risk-control definition' });
  const parsed = parseViewSubmission(payload);
  assert.deepEqual(parsed, {
    action: 'confirm_submit',
    slug: 'refund',
    round: 3,
    formValues: { ask_H1: 'Yes', ask_H2: 'Next week', verdict: 'accept', notes: 'Go with the risk-control definition' },
  });
});

test('round trip: unanswered items **do not appear** in formValues (filling in an empty string would record "unanswered" as "answered with nothing")', () => {
  const v = buildDecisionModal(CTX, { items: ITEMS, verdict: true, submitText: 's', notesLabel: 'n', notesPlaceholder: 'p' });
  const parsed = parseViewSubmission(submit(v, { ask_H1: 'Yes' }));
  assert.deepEqual(parsed?.formValues, { ask_H1: 'Yes' });
});

test('filing modal: a DRI dropdown with the recommendation preselected; the submission comes back as assignee', () => {
  const ctx: ModalContext = { action: 'go', slug: 'refund', kind: 'go' };
  const v = buildGoModal(ctx, ['M', 'CC'], 'CC');
  const el = (v.blocks as Record<string, unknown>[])[0] as { element: { type: string; initial_option?: { value: string } } };
  assert.equal(el.element.type, 'static_select');
  assert.equal(el.element.initial_option?.value, 'CC');
  assert.deepEqual(parseViewSubmission(submit(v, { assignee: 'M' })), { action: 'go', slug: 'refund', round: 0, formValues: { assignee: 'M' } });
});

test('filing modal: no DRI pool available (the degraded path after a daemon restart) -> fall back to free text, never let the button do nothing', () => {
  const v = buildGoModal({ action: 'go', slug: 's', kind: 'go' }, [], null);
  const el = (v.blocks as Record<string, unknown>[])[0] as { element: { type: string } };
  assert.equal(el.element.type, 'plain_text_input');
});

test('parseViewSubmission: broken / missing private_metadata, or no slug -> null (unrecognised is unrecognised; never guess a slug)', () => {
  assert.equal(parseViewSubmission({ view: { private_metadata: 'not json' } }), null);
  assert.equal(parseViewSubmission({ view: { private_metadata: '{}' } }), null);
  assert.equal(parseViewSubmission({ view: { private_metadata: '{"action":"go"}' } }), null);
  assert.equal(parseViewSubmission({}), null);
});

test('flattenStateValues: flattens the two levels; a dropdown takes selected_option.value, a text field takes value', () => {
  assert.deepEqual(
    flattenStateValues({
      values: {
        a: { ask_H1: { type: 'static_select', selected_option: { value: 'x' } } },
        b: { notes: { type: 'plain_text_input', value: 'y' } },
        c: { empty: { type: 'plain_text_input', value: '' } },
        d: { unset: { type: 'static_select', selected_option: null } },
      },
    }),
    { ask_H1: 'x', notes: 'y' },
  );
  assert.deepEqual(flattenStateValues(undefined), {});
});

test('decision modal: even with no open questions it produces a valid view (Slack rejects empty blocks outright)', () => {
  const v = buildDecisionModal(CTX, { items: [], submitText: 's', notesLabel: 'n', notesPlaceholder: 'p' });
  assert.ok((v.blocks as unknown[]).length >= 1);
});

// -- plain_text limits are per field, and going over is not truncation but **total failure** ---------
// view.title/submit/close = 24; option.text/value = 75; placeholder = 150; input.label/hint = 2000.
// Violate any of them and views.open returns nothing but ok:false — the user-visible symptom is "the
// button does nothing", with a single invalid_arguments line in the log. This class of error only appears
// when someone clicks once in a real workspace, so it is pinned here.
const lenOf = (t: string): number => Array.from(t).length;
const textOf = (o: unknown): string => (o as { text: string }).text;

test('modal title/submit/close cap at 24 characters — over that, views.open returns ok:false outright and the person sees "the button does nothing"', () => {
  const v = buildDecisionModal(CTX, { items: ITEMS, submitText: 'Submit the decision'.repeat(10), notesLabel: 'n', notesPlaceholder: 'p', title: 'A really really really long modal title'.repeat(3) });
  assert.ok(lenOf(textOf(v.title)) <= 24, `title over the limit: ${textOf(v.title)}`);
  assert.ok(lenOf(textOf(v.submit)) <= 24, `submit over the limit: ${textOf(v.submit)}`);
  assert.ok(lenOf(textOf(v.close)) <= 24);
  assert.match(textOf(v.submit), /…$/, 'truncation has to be visible as truncation');
});

test('empty submit text is equally ok:false (an empty plain_text is invalid) -> fall back to a placeholder, never send a modal that cannot open', () => {
  const v = buildDecisionModal(CTX, { items: ITEMS, submitText: '   ', notesLabel: 'n', notesPlaceholder: 'p', title: '' });
  assert.equal(textOf(v.submit), 'Submit');
  assert.equal(textOf(v.title), 'Requirement review');
});

test('truncation works on code points: an emoji surrogate pair is never split in half (invalid UTF-16 gets the whole view rejected)', () => {
  const v = buildDecisionModal(CTX, { items: [], submitText: '🔴'.repeat(40), notesLabel: 'n', notesPlaceholder: 'p' });
  const t = textOf(v.submit);
  assert.ok(lenOf(t) <= 24);
  assert.doesNotMatch(t, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'no lone surrogate should appear');
});

test('an open-question label caps at 2000 rather than 150 — a PM should not see half a question inside the modal', () => {
  const long = 'w'.repeat(600);
  const v = buildDecisionModal(CTX, { items: [{ id: 'H1', prompt: long, options: [{ label: 'a' }] }], submitText: 's', notesLabel: 'n', notesPlaceholder: 'p' });
  const label = textOf((v.blocks as { label: unknown }[])[0].label);
  assert.ok(lenOf(label) > 150, '150 is the placeholder limit, not the label limit');
  assert.ok(lenOf(label) <= 2000);
});

test('dropdown option text/value cap at 75; the value gets no ellipsis (it is fed back to the core verbatim, not read by a person)', () => {
  const long = 'x'.repeat(200);
  const v = buildDecisionModal(CTX, { items: [{ id: 'H1', prompt: 'p', options: [{ label: long }] }], submitText: 's', notesLabel: 'n', notesPlaceholder: 'p' });
  const opt = (v.blocks as { element: { options: { text: unknown; value: string }[] } }[])[0].element.options[0];
  assert.ok(lenOf(textOf(opt.text)) <= 75);
  assert.equal(opt.value, 'x'.repeat(75));
});
