// Slack provider layer — **text capping**. Every piece of text in Block Kit has its own limit, and all
// three ways of violating them produce the **same** symptom: `ok:false / invalid_blocks`, the card never
// appears, and the log has a single warning that points at nothing.
//
//   1. Over the limit — and the limits are per field (header 150 / section 3000 / button text 75 /
//      modal title 24…), so one flat number is wrong at both ends;
//   2. Empty string — neither `plain_text` nor `mrkdwn` **accepts empty text**, and one empty value gets
//      the whole message rejected;
//   3. Invalid UTF-16 — slicing by UTF-16 code unit splits an emoji's surrogate pair in half, and the
//      entire payload is rejected.
//
// All three rules live in this one implementation, shared by modals and message cards. This is not
// fastidiousness: these helpers originally existed only in slack/modal.ts (#18) while the neighbouring
// messaging/slack.ts was still using a bare `.slice()` — the same class of trap that only surfaces in a
// real workspace, and half-fixed is more dangerous than unfixed, because it looks done.
import { BK_LIMIT } from './blockkit.ts';

// Truncate by **code point** (not by UTF-16 code unit).
export function clip(text: string, max: number): string {
  return Array.from(text ?? '').slice(0, max).join('');
}

// Human-facing text that goes over the limit keeps an ellipsis, so "this was truncated" stays visible.
export function ellipsize(text: string, max: number): string {
  const t = text ?? '';
  return Array.from(t).length <= max ? t : `${clip(t, max - 1)}…`;
}

// A plain_text element. The fallback covers "empty is equally invalid": when the caller has no content,
// fall back to a neutral placeholder rather than sending a message Slack will reject outright.
export function plainText(text: string, max: number, fallback = '—'): Record<string, unknown> {
  return { type: 'plain_text', text: ellipsize((text ?? '').trim() || fallback, max), emoji: true };
}

// An mrkdwn element (section.text / context.elements). Equally intolerant of empty.
export function mrkdwnText(text: string, max: number = BK_LIMIT.sectionText, fallback = '—'): Record<string, unknown> {
  return { type: 'mrkdwn', text: ellipsize((text ?? '').trim() || fallback, max) };
}

// Whether a piece of text has "no content" — which decides whether to **omit the block entirely**
// (cleaner than a placeholder, and legal where an empty one is not).
export function blank(text: string | undefined | null): boolean {
  return !(text ?? '').trim();
}
