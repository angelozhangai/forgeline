// The **single predicate** of the channel intake gate (provider-neutral). Both the live message
// entry point (daemon/listen.ts) and offline backfill (messaging/backfill.ts) ask this, so the two
// paths can no longer disagree about what counts as a requirement.
//
// The gate itself is a **cost guard**: a document link casually shared or forwarded in a channel
// should not trigger a Gate A run (one Gate A run is real money), so a channel message must @-mention
// this bot to enter the pipeline. A p2p DM is inherently directed and needs no mention.
//
// Three states rather than a boolean — "confirmed nobody mentioned it" and "cannot be confirmed" must
// stay distinct:
//   · collapsed into false (treated as not mentioned) -> a provider that cannot report mentions lets
//     nothing through at all, and the whole of offline backfill silently stops working;
//   · collapsed into true (treated as mentioned) -> the entire channel intake is quietly wide open and
//     the gate is pointless.
// The two paths treat the third state **differently on purpose**, and that difference is the reason
// this file exists:
//   · live: ignore (and warn). The message is still in the channel; someone can @-mention it again,
//     at the cost of one repost.
//   · backfill: register as usual (and warn). That message is already in the past, so ignoring it means
//     silently swallowing a requirement filed while offline — which is the one and only purpose
//     backfill serves. It trades "possibly one wasted Gate A run" for "never lose a requirement".
import type { InboundMessage } from './model.ts';

export type MentionGate =
  | 'admit' // a DM, or a confirmed mention of this bot -> enters the pipeline
  | 'ignore' // confirmed to be a channel message with no mention of this bot -> does not enter
  | 'unconfirmable'; // a channel message, but undecidable (the provider's envelope carries no mentions / the bot's own id is unavailable)

export function mentionGate(m: Pick<InboundMessage, 'isGroup' | 'mentionedBot'>): MentionGate {
  if (!m.isGroup) return 'admit'; // omitted (an older provider, or a test that did not set it) is also treated as non-channel, matching existing semantics
  if (m.mentionedBot === true) return 'admit';
  if (m.mentionedBot === false) return 'ignore';
  return 'unconfirmable';
}
