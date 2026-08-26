// Slack provider layer — **the form blocks, and the modal that used to be the only way to show them**.
//
// The premise this file was written on is no longer true, and the correction matters enough to record:
// input blocks **are** legal in a message (Slack lists the input block's surfaces as modals, messages and
// home tabs), and since 2020 every `block_actions` payload carries the full `state` of the surface it came
// from — messages included. So a Slack card can hold a form and a submit button after all, exactly like a
// Feishu one, and that is what messaging/slack.ts now renders. Verified against a real workspace rather
// than taken from the docs: a message carrying radio_buttons + static_select + plain_text_input was
// accepted, and pressing its button returned all three answers in `state.values`.
//
// Inline is better on every axis that has ever bitten here: one click instead of two, no `trigger_id` to
// expire inside three seconds, and — the big one — **no form content held in process memory**, so a daemon
// restart cannot turn a live card into a degraded free-text box.
//
// The modal path stays, for one reason that is not nostalgia: **cards posted before this change are still
// sitting in Slack with a modal button on them**, and a button that dies on upgrade is precisely the
// failure this repo refuses to ship. It is the compatibility path, not the main one.
//
// How the context survives the modal round trip: when the button is clicked we know {action, slug, round},
// but the view_submission no longer carries that card. Slack provides private_metadata, an opaque string
// that travels with the view. On the core side, the shape of InboundCardAction is **entirely unchanged**
// either way (action/slug/value/formValues).
import type { DecisionItem } from '../gates/envelopes.ts';
import { answerableDecisions, DECISION_CAP } from '../gates/envelopes.ts';
import { BK_LIMIT } from './blockkit.ts';
import { clip, plainText } from './text.ts';

// What the modal-opening button carries (the block_actions action value), which is also what goes into
// private_metadata.
export interface ModalContext {
  action: string; // the business action the core should receive on submit (confirm_submit / gateb_answer_submit / go …)
  slug: string;
  round?: number; // guards against duplicate delivery when a channel card is edited in place
  kind: 'decision' | 'go'; // decides which modal to open
}

// -- plain_text limits are **per field**, and going over is not truncation but total failure ---------
// view.title / submit / close = 24; option.text / option.value = 75; placeholder = 150;
// input.label / hint = 2000 (the numbers live in the limits table in slack/blockkit.ts — the single
// source of truth). One flat number is wrong at both ends:
//   · a title or submit label over 24 -> views.open returns ok:false outright -> what the person sees is
//     "the button does nothing", the exact shape this repo most needs to avoid (nothing points at the
//     real cause);
//   · an open-question label clipped to 150 -> the PM sees only half the question inside the modal.
// Both only surface when someone clicks a button in a real workspace -> so cap per field here, and pin it
// locally.
//
// Truncation, empty strings and surrogate pairs are implemented in slack/text.ts, **shared** with the
// message-card side.
const plain = (text: string, max: number = BK_LIMIT.placeholder): Record<string, unknown> => plainText(text, max);
// title/submit/close: must not exceed 24 and must **not be empty** (an empty plain_text is equally
// ok:false) -> empty falls back to a placeholder.
const chip = (text: string, fallback: string): Record<string, unknown> => plainText(text, BK_LIMIT.viewChip, fallback);
const mrkdwnEl = (text: string): Record<string, unknown> => ({ type: 'mrkdwn', text });

// A dropdown option: both text and value are capped at 75. Truncate rather than error — option labels are
// written by people, and a long one is simply clipped; it must never make the whole card unsendable. The
// value gets no ellipsis: it is the raw value fed back to the core, not something a person reads.
function option(label: string, value: string, description?: string): Record<string, unknown> {
  return {
    text: plain(label, BK_LIMIT.optionText),
    value: clip(value, BK_LIMIT.optionValue),
    // Radio buttons and checkboxes render a second, quieter line under the label; a select menu ignores it.
    // The impact of choosing an option belongs there rather than crammed into the label, which caps at 75.
    ...(description ? { description: plain(description, BK_LIMIT.optionText) } : {}),
  };
}

// One open question -> one input block (block_id = action_id = ask_<id>, lined up in the same order as
// composeDecisionAnswer).
// optional:true is deliberate: the PM may answer only some of them and write the rest in the notes box —
// matching the semantics on the Feishu side.
// Radio buttons show every option at once, which is what a decision wants — you compare them, you do not
// hunt for them in a dropdown. They cap at 10 options though, and a long list is a wall of text, so past
// RADIO_MAX it falls back to a select menu. Both return the same shape, so nothing downstream cares which
// one was rendered.
const RADIO_MAX = 5;
export function askBlock(id: string, item: DecisionItem): Record<string, unknown> {
  const options = [
    ...item.options.slice(0, 10).map((o) => option(`${o.recommended ? '★ ' : ''}${o.label}`, o.label, o.impact || undefined)),
    option('Other (write it in the notes below)', '__other__'),
  ];
  const element =
    options.length <= RADIO_MAX
      ? { type: 'radio_buttons', action_id: `ask_${id}`, options }
      : { type: 'static_select', action_id: `ask_${id}`, placeholder: plain('Choose…'), options };
  return {
    type: 'input',
    block_id: `ask_${id}`,
    optional: true,
    label: plain(`${id}. ${item.prompt}`, BK_LIMIT.inputLabel),
    element,
    ...(item.hint ? { hint: plain(`Suggestion: ${item.hint}`, BK_LIMIT.inputLabel) } : {}),
  };
}

export interface DecisionModalOpts {
  items: DecisionItem[];
  verdict?: boolean;
  submitText: string;
  notesLabel: string;
  notesPlaceholder: string;
  title?: string;
}

// The decision modal (the PM answering at Gate A / the maintainer signing off at Gate B).
export function buildDecisionModal(ctx: ModalContext, o: DecisionModalOpts): Record<string, unknown> {
  return view(ctx, o.title ?? 'Requirement review', o.submitText, decisionBlocks(o));
}

// The decision form's input blocks, with no surface wrapped around them — a message and a modal render the
// **same** blocks, so the two can never drift into asking different questions.
export function decisionBlocks(o: DecisionModalOpts): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = answerableDecisions(o.items.slice(0, DECISION_CAP)).map(({ id, item }) => askBlock(id, item));
  if (o.verdict) {
    blocks.push({
      type: 'input',
      block_id: 'verdict',
      optional: true,
      label: plain('Overall verdict', BK_LIMIT.inputLabel),
      element: {
        type: 'static_select',
        action_id: 'verdict',
        placeholder: plain('Overall verdict…'),
        options: [option('✅ Accept the suggestions and confirm', 'accept'), option('📝 Partially accept (see the per-question answers / notes)', 'partial')],
      },
    });
  }
  blocks.push({
    type: 'input',
    block_id: 'notes',
    optional: true,
    label: plain(o.notesLabel, BK_LIMIT.inputLabel),
    element: { type: 'plain_text_input', action_id: 'notes', multiline: true, placeholder: plain(o.notesPlaceholder) },
  });
  return blocks;
}

// The filing modal (the maintainer choosing a DRI).
// An empty pool = the degraded path (after a daemon restart the form content is no longer in memory) ->
// fall back to a free-text field, where a person can still type the short code. Whether the short code is
// valid is already guarded by the allowlist on the go side, so a missing pool must never make the button
// do nothing.
export function buildGoModal(ctx: ModalContext, pool: string[], picked: string | null): Record<string, unknown> {
  return view(ctx, 'File it · create issues', '✅ File it', goBlocks(pool, picked));
}

// The filing form's input block, surface-free (see decisionBlocks).
export function goBlocks(pool: string[], picked: string | null): Record<string, unknown>[] {
  const element = pool.length
    ? {
        type: 'static_select',
        action_id: 'assignee',
        placeholder: plain('Assign a DRI…'),
        options: pool.map((c) => option(c, c)),
        ...(picked && pool.includes(picked) ? { initial_option: option(picked, picked) } : {}),
      }
    : { type: 'plain_text_input', action_id: 'assignee', placeholder: plain('Enter a DRI short code, e.g. M') };
  return [{ type: 'input', block_id: 'assignee', optional: true, label: plain('Assign a DRI', BK_LIMIT.inputLabel), element }];
}

function view(ctx: ModalContext, title: string, submitText: string, blocks: Record<string, unknown>[]): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: 'forge_form',
    // The only carrier of context: a view_submission has no original card, and this is what brings
    // {action,slug,round} back.
    private_metadata: JSON.stringify({ action: ctx.action, slug: ctx.slug, round: ctx.round ?? 0 }),
    title: chip(title, 'Requirement review'),
    submit: chip(submitText, 'Submit'),
    close: chip('Cancel', 'Cancel'),
    blocks: blocks.length ? blocks : [{ type: 'section', text: mrkdwnEl('(nothing to fill in)') }],
  };
}

// -- view_submission -> flat formValues --------------------------------------
// Slack's state.values is doubly nested: { [block_id]: { [action_id]: {type, value|selected_option} } }.
// The core only understands a flat Record<string,string> (ask_*/verdict/notes/assignee), so flatten it
// here.
// Items left unselected or blank **do not appear** in the result — never fill in an empty string, or
// composeDecisionAnswer would record "unanswered" as "answered with nothing".
export function flattenStateValues(state: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const values = (state as { values?: Record<string, Record<string, unknown>> } | undefined)?.values;
  if (!values) return out;
  for (const actions of Object.values(values)) {
    for (const [actionId, el] of Object.entries(actions ?? {})) {
      const e = el as { value?: unknown; selected_option?: { value?: unknown } };
      const picked = typeof e?.selected_option?.value === 'string' ? e.selected_option.value : undefined;
      const typed = typeof e?.value === 'string' ? e.value : undefined;
      const v = picked ?? typed;
      if (v !== undefined && v !== '') out[actionId] = v;
    }
  }
  return out;
}

export interface ParsedSubmission {
  action: string;
  slug: string;
  round: number;
  formValues: Record<string, string>;
}

// Parse one view_submission payload. A broken or missing private_metadata -> null (unrecognised is
// unrecognised; never guess a slug).
export function parseViewSubmission(payload: Record<string, unknown>): ParsedSubmission | null {
  const view = payload.view as { private_metadata?: unknown; state?: unknown } | undefined;
  if (!view) return null;
  let meta: { action?: unknown; slug?: unknown; round?: unknown };
  try {
    meta = JSON.parse(String(view.private_metadata ?? '')) as typeof meta;
  } catch {
    return null;
  }
  const action = typeof meta?.action === 'string' ? meta.action : '';
  const slug = typeof meta?.slug === 'string' ? meta.slug : '';
  if (!action || !slug) return null;
  return { action, slug, round: Number(meta?.round) || 0, formValues: flattenStateValues(view.state) };
}
