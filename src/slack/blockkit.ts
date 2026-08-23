// Slack provider layer — **Block Kit structural constraints**: the limits table plus a validator.
//
// Why a separate validator earns its place: when Slack rejects a message or a modal, it replies with
// `ok:false, error:"invalid_blocks"` — **without saying which block, which field, or by how much**. What
// a person sees is "the card never showed up" or "the button does nothing", and the log holds a single
// warning. That is precisely the shape this repo exists to eliminate (nothing points at the real cause).
//
// So this file carries two jobs:
//   1. The limits table is the **single source of truth**: the rendering side (slack/text.ts +
//      messaging/slack.ts + slack/modal.ts) caps against it.
//   2. The validator is used in **two places** —
//      · in unit tests, against every card and modal Forge can emit, moving this class of
//        only-visible-in-a-real-workspace trap into CI;
//      · at runtime, **only after Slack has already said no**, translating invalid_blocks into
//        "block 3, section.text is empty". It never runs on the happy path, so it is not a cost on the
//        hot path.
//
// The numbers come from Slack's official Block Kit reference. They are Slack's spec, not our preference
// — they should only change because Slack changed them.
export const BK_LIMIT = {
  blocksPerMessage: 50,
  blocksPerView: 100,
  headerText: 150,
  sectionText: 3000,
  contextText: 3000,
  contextElements: 10,
  fieldText: 2000,
  fieldsPerSection: 10,
  buttonText: 75,
  buttonValue: 2000,
  actionId: 255,
  elementsPerActions: 25,
  optionText: 75,
  optionValue: 75,
  optionsPerSelect: 100,
  placeholder: 150,
  inputLabel: 2000,
  viewChip: 24, // title / submit / close
  privateMetadata: 3000,
  callbackId: 255,
} as const;

// A lone surrogate (what you get from splitting an emoji down the middle). Slack rejects the whole
// payload on invalid UTF-16.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);
const cp = (s: string): number => Array.from(s).length;

// A {type:'plain_text'|'mrkdwn', text} text object: non-empty, within the limit, and valid UTF-16.
function checkText(where: string, v: unknown, max: number, out: string[], kinds = ['plain_text', 'mrkdwn']): void {
  const o = obj(v);
  if (!o) return void out.push(`${where}: missing text object`);
  if (typeof o.type !== 'string' || !kinds.includes(o.type)) out.push(`${where}: type should be ${kinds.join('/')}, got ${String(o.type)}`);
  const t = o.text;
  if (typeof t !== 'string') return void out.push(`${where}: text is not a string`);
  if (t === '') out.push(`${where}: text is empty (Slack does not accept empty text; the whole payload is rejected)`);
  if (cp(t) > max) out.push(`${where}: text exceeds the limit (${cp(t)} > ${max})`);
  if (LONE_SURROGATE.test(t)) out.push(`${where}: text contains a lone surrogate (an emoji was truncated into invalid UTF-16)`);
}

function checkOption(where: string, v: unknown, out: string[]): void {
  const o = obj(v);
  if (!o) return void out.push(`${where}: option is not an object`);
  checkText(`${where}.text`, o.text, BK_LIMIT.optionText, out, ['plain_text']);
  if (typeof o.value !== 'string' || o.value === '') out.push(`${where}.value: missing or empty`);
  else if (cp(o.value) > BK_LIMIT.optionValue) out.push(`${where}.value: exceeds the limit (${cp(o.value)} > ${BK_LIMIT.optionValue})`);
}

function checkElement(where: string, v: unknown, out: string[], actionIds: string[]): void {
  const e = obj(v);
  if (!e) return void out.push(`${where}: element is not an object`);
  const id = e.action_id;
  if (typeof id === 'string') {
    if (cp(id) > BK_LIMIT.actionId) out.push(`${where}.action_id: exceeds the limit (${cp(id)} > ${BK_LIMIT.actionId})`);
    actionIds.push(id);
  }
  if (e.placeholder !== undefined) checkText(`${where}.placeholder`, e.placeholder, BK_LIMIT.placeholder, out, ['plain_text']);
  switch (e.type) {
    case 'button': {
      checkText(`${where}.text`, e.text, BK_LIMIT.buttonText, out, ['plain_text']);
      const val = e.value;
      if (val !== undefined) {
        if (typeof val !== 'string' || val === '') out.push(`${where}.value: should be a non-empty string`);
        else if (cp(val) > BK_LIMIT.buttonValue) out.push(`${where}.value: exceeds the limit (${cp(val)} > ${BK_LIMIT.buttonValue})`);
      }
      // Slack recognises only these two styles; anything else (including 'default') fails the block.
      if (e.style !== undefined && e.style !== 'primary' && e.style !== 'danger') out.push(`${where}.style: only primary/danger are allowed, got ${String(e.style)}`);
      break;
    }
    case 'static_select': {
      const opts = arr(e.options);
      if (!opts || opts.length === 0) out.push(`${where}.options: a static select must have at least one option`);
      else {
        if (opts.length > BK_LIMIT.optionsPerSelect) out.push(`${where}.options: exceeds the limit (${opts.length} > ${BK_LIMIT.optionsPerSelect})`);
        for (const [i, o] of opts.entries()) checkOption(`${where}.options[${i}]`, o, out);
      }
      if (e.initial_option !== undefined) checkOption(`${where}.initial_option`, e.initial_option, out);
      break;
    }
    case 'plain_text_input':
      break;
    default:
      out.push(`${where}.type: element type ${String(e.type)} should never be emitted by this repo`);
  }
}

function checkBlock(where: string, v: unknown, out: string[], actionIds: string[]): void {
  const b = obj(v);
  if (!b) return void out.push(`${where}: block is not an object`);
  switch (b.type) {
    case 'header':
      checkText(`${where}.text`, b.text, BK_LIMIT.headerText, out, ['plain_text']);
      break;
    case 'section': {
      const fields = arr(b.fields);
      if (b.text === undefined && fields === null) out.push(`${where}: section has neither text nor fields`);
      if (b.text !== undefined) checkText(`${where}.text`, b.text, BK_LIMIT.sectionText, out);
      if (fields) {
        if (fields.length === 0) out.push(`${where}.fields: empty array (either give it content or do not emit the block)`);
        if (fields.length > BK_LIMIT.fieldsPerSection) out.push(`${where}.fields: exceeds the limit (${fields.length} > ${BK_LIMIT.fieldsPerSection})`);
        for (const [i, f] of fields.entries()) checkText(`${where}.fields[${i}]`, f, BK_LIMIT.fieldText, out);
      }
      break;
    }
    case 'context': {
      const els = arr(b.elements);
      if (!els || els.length === 0) out.push(`${where}.elements: empty`);
      else {
        if (els.length > BK_LIMIT.contextElements) out.push(`${where}.elements: exceeds the limit (${els.length} > ${BK_LIMIT.contextElements})`);
        for (const [i, el] of els.entries()) checkText(`${where}.elements[${i}]`, el, BK_LIMIT.contextText, out);
      }
      break;
    }
    case 'actions': {
      const els = arr(b.elements);
      if (!els || els.length === 0) out.push(`${where}.elements: an actions block must have at least one element (an empty array = the whole message is rejected)`);
      else {
        if (els.length > BK_LIMIT.elementsPerActions) out.push(`${where}.elements: exceeds the limit (${els.length} > ${BK_LIMIT.elementsPerActions})`);
        for (const [i, el] of els.entries()) checkElement(`${where}.elements[${i}]`, el, out, actionIds);
      }
      break;
    }
    case 'input': {
      checkText(`${where}.label`, b.label, BK_LIMIT.inputLabel, out, ['plain_text']);
      if (b.hint !== undefined) checkText(`${where}.hint`, b.hint, BK_LIMIT.inputLabel, out, ['plain_text']);
      if (typeof b.block_id === 'string' && b.block_id === '') out.push(`${where}.block_id: empty string`);
      if (b.element === undefined) out.push(`${where}.element: the input block is missing its element`);
      else checkElement(`${where}.element`, b.element, out, actionIds);
      break;
    }
    case 'divider':
      break;
    default:
      out.push(`${where}.type: block type ${String(b.type)} should never be emitted by this repo`);
  }
}

// Validate a set of blocks. Returns descriptions of the violations; **an empty array means structurally
// valid** (which does not guarantee Slack will accept it, only that none of this class of trap remains).
export function validateBlocks(blocks: unknown, opts: { max?: number; where?: string } = {}): string[] {
  const max = opts.max ?? BK_LIMIT.blocksPerMessage;
  const where = opts.where ?? 'blocks';
  const out: string[] = [];
  const list = arr(blocks);
  if (!list) return [`${where}: not an array`];
  if (list.length === 0) out.push(`${where}: empty (Slack does not accept an empty block list)`);
  if (list.length > max) out.push(`${where}: too many blocks (${list.length} > ${max})`);
  const actionIds: string[] = [];
  for (const [i, b] of list.entries()) checkBlock(`${where}[${i}]`, b, out, actionIds);
  // action_id must be unique within one message or modal, or Slack rejects the whole thing.
  const dup = actionIds.filter((id, i) => actionIds.indexOf(id) !== i);
  for (const id of [...new Set(dup)]) out.push(`${where}: duplicate action_id "${id}" (it must be unique within one payload)`);
  return out;
}

// Validate the attachments of a chat.postMessage / chat.update (this repo hangs its blocks on an
// attachment — that is where the colour bar lives).
export function validateAttachments(attachments: unknown): string[] {
  const list = arr(attachments);
  if (!list) return ['attachments: not an array'];
  const out: string[] = [];
  for (const [i, a] of list.entries()) {
    const o = obj(a);
    if (!o) {
      out.push(`attachments[${i}]: not an object`);
      continue;
    }
    if (typeof o.color === 'string' && !/^#[0-9a-fA-F]{6}$/.test(o.color)) out.push(`attachments[${i}].color: should be #rrggbb, got ${o.color}`);
    out.push(...validateBlocks(o.blocks, { where: `attachments[${i}].blocks` }));
  }
  return out;
}

// Validate a views.open view. A modal adds three things: the 24-character cap on the title trio,
// private_metadata, and callback_id.
export function validateView(view: unknown): string[] {
  const v = obj(view);
  if (!v) return ['view: not an object'];
  const out: string[] = [];
  if (v.type !== 'modal') out.push(`view.type: should be modal, got ${String(v.type)}`);
  checkText('view.title', v.title, BK_LIMIT.viewChip, out, ['plain_text']);
  if (v.submit !== undefined) checkText('view.submit', v.submit, BK_LIMIT.viewChip, out, ['plain_text']);
  if (v.close !== undefined) checkText('view.close', v.close, BK_LIMIT.viewChip, out, ['plain_text']);
  if (v.private_metadata !== undefined) {
    if (typeof v.private_metadata !== 'string') out.push('view.private_metadata: not a string');
    else if (cp(v.private_metadata) > BK_LIMIT.privateMetadata) out.push(`view.private_metadata: exceeds the limit (${cp(v.private_metadata)} > ${BK_LIMIT.privateMetadata})`);
  }
  if (typeof v.callback_id === 'string' && cp(v.callback_id) > BK_LIMIT.callbackId) out.push(`view.callback_id: exceeds the limit (${cp(v.callback_id)} > ${BK_LIMIT.callbackId})`);
  out.push(...validateBlocks(v.blocks, { max: BK_LIMIT.blocksPerView, where: 'view.blocks' }));
  return out;
}

// Compress the validation result into one readable log suffix (Slack will only say invalid_blocks; this
// line is the actual location information).
export function explain(problems: string[]): string {
  if (problems.length === 0) return '(the structural self-check found nothing — most likely permissions, the channel, or credentials rather than the payload)';
  return `structural self-check: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? `; …${problems.length} in total` : ''}`;
}
