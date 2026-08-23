// Offline backfill (**provider-neutral**): channel messages sent while the IM connection was down (the
// machine was off, asleep, or the network flapped) are not re-delivered on reconnect, so history is
// actively pulled at three points — startup, reconnect, and periodically — and any requirement document
// links after the cursor are registered.
// Channel history is itself a queue: chat_cursor records the watermark of what we have processed,
// addPrd de-duplicates by document, and backfilling the same range twice is harmless.
//
// Why this stays in the core with only the one API round trip in the adapter: every line here is the
// correctness logic of "never lose a requirement while offline" — the cursor only moves forward, the
// boundary entry is filtered again, re-entrancy is guarded, link extraction has a fallback order, and
// the intake gate has a defined treatment of "unconfirmable". None of that depends on which IM is in
// use. Adding Slack only required its adapter to implement listHistorySince
// (conversations.history); this file did not change by a line.
import { log } from '../util/log.ts';
import { claimDocs, type DocRef } from '../docs/index.ts';
import { mentionGate } from './gate.ts';
import { addPrd } from '../intake.ts';
import * as cursors from '../store/cursors.ts';
import { port } from './index.ts';
import type { InboundMessage } from './model.ts';

// The requirement documents in one history message: handed to the document source registry to be
// claimed (the body plus the fallback text blocks the adapter supplied — the link in a document share
// card or a rich-text post is not in the body). This is the same claimDocs used by the live message
// entry point handleMessage, so the two paths cannot drift apart.
function docsIn(m: InboundMessage): DocRef[] {
  return claimDocs({ text: m.text, searchTexts: m.searchTexts });
}

// Backfill one channel: claim requirement documents from messages after the cursor -> addPrd
// (de-duplicated by doc_ref). Returns how many were newly registered.
export async function backfillChat(chatId: string): Promise<number> {
  const cursorMs = cursors.getCursor(chatId) ?? Date.now();
  const msgs = await port.listHistorySince(chatId, cursorMs);
  let maxTs = cursorMs;
  let n = 0;
  let unconfirmable = 0;
  for (const m of msgs) {
    const ts = m.createTime;
    // An adapter's time filter may only have second precision (Feishu's start_time does), so the
    // boundary entry comes back again -> the core filters once more, by millisecond.
    if (ts <= cursorMs) continue;
    // The channel intake gate (**the same predicate** as the live entry point, see messaging/gate.ts):
    // a document casually shared in a channel should not cost a Gate A run.
    // But the third state is treated here **the opposite way from live** — unconfirmable is registered
    // as usual. The reason is that this message is already in the past: ignoring it means silently
    // swallowing a requirement filed while offline, and that is backfill's only reason to exist.
    // Better a wasted Gate A run than a lost requirement.
    const gate = mentionGate(m);
    if (gate === 'unconfirmable') unconfirmable++;
    if (gate !== 'ignore') {
      for (const doc of docsIn(m)) {
        // The poster and the originating message id are carried through — that is what makes a
        // backfilled requirement **look the same** as a live one: the status card replies underneath
        // the PM's message and can @-mention them. Registration proceeds if either is missing (a
        // backfill may legitimately not have them).
        const r = await addPrd({ doc, chatId, posterId: m.senderId, intakeMsgId: m.messageId });
        if (r.ok && r.session && r.created) {
          n++;
          log.ok(`Backfill registered: ${r.session.slug} (channel message from the outage)`);
        }
      }
    }
    if (ts > maxTs) maxTs = ts; // advance the cursor even for gated-out messages, or every round rescans the same batch
  }
  // "Unconfirmable" is the one opening this round did not gate: seeing any means this provider's
  // history envelope carries no mentions (or the bot's own id is unconfigured), and the offline path is
  // in fact still wide open. This log line *is* that observation — no fishing out a history payload by
  // hand, one daemon run tells you.
  if (unconfirmable > 0) {
    log.warn(
      `Backfill: ${unconfirmable} channel history messages could not be confirmed as mentioning the bot (${port.id}'s history envelope carries no mentions, or the bot's own id is unconfigured) ` +
        '-> registered as usual, on the "never lose a requirement" rule. This provider\'s offline intake gate is effectively not in force.',
    );
  }
  cursors.advanceCursor(chatId, maxTs);
  return n;
}

let backfilling = false; // re-entrancy guard: startup, reconnect and the periodic tick can all trigger this

// Backfill every known channel: the watched channels the adapter reports are seeded first (from `now`
// on the first pass, so ancient history is not pulled), then each channel is backfilled.
export async function backfillAll(): Promise<number> {
  if (backfilling) return 0;
  backfilling = true;
  try {
    for (const c of port.watchedChats()) cursors.seedCursor(c, Date.now());
    let total = 0;
    for (const c of cursors.allChats()) total += await backfillChat(c);
    if (total > 0) log.ok(`Backfill complete: ${total} requirements from the outage newly registered`);
    return total;
  } finally {
    backfilling = false;
  }
}
