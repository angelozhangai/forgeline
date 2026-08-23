// Thin transport seam — **the provider-neutral message model**. The core (worker/actions/gates/notify)
// only describes the *meaning* of what it wants to send and never touches Feishu or Slack JSON. Each
// provider's adapter (see messaging/<provider>.ts) renders these semantic blocks into its own card
// format (Feishu card 2.0 / Slack Block Kit) and parses its own inbound events back into the
// InboundEvent shapes below.
//
// Design trade-off: blocks are at the **semantic level** (a decision form / a stats row / a callback
// button / a pet row) rather than at Feishu's micro tag level (markdown/column_set/select_static…).
// Only the semantic level is genuinely portable: a renderer knows how to turn "a decision form" into a
// Feishu form and equally into a Slack actions block, whereas micro tags would weld Feishu details
// into the core.
import type { DecisionItem } from '../gates/envelopes.ts';

// The card's primary colour (semantic: danger / info / success / neutral / warning). Each provider maps
// it to its own template colours.
export type CardColor = 'red' | 'blue' | 'green' | 'grey' | 'orange';

// Semantic tone of a prominent banner (danger = red, warning = orange, info = blue). Each adapter
// realises it its own way.
export type CalloutTone = 'danger' | 'warning' | 'info';

// The meaning of a callback button (which action a click triggers, against which slug, carrying which
// value).
export interface CardButton {
  text: string;
  style: 'primary' | 'default' | 'danger';
  action: string; // business action: confirm_submit/gateb/go/retry/force_confirm/...
  slug: string;
  value?: Record<string, unknown>; // extra fields passed through to the callback (such as `round`, which de-duplicates repeated deliveries of an in-place-edited card)
}

// One residual review finding / open question (used by findingList). `lead` is the main question or
// problem; `notes` are secondary lines such as location or suggestion (only the ones that are known).
// `severity` is semantic (high/med/low) and each adapter maps it to its own colour label — the core
// holds no provider colour syntax whatsoever.
export interface FindingLine {
  severity?: string;
  lead: string;
  notes?: { label: string; text: string }[];
}

// One "semantic block" of card content.
export type CardBlock =
  | { kind: 'text'; md: string } // an ordinary markdown paragraph
  | { kind: 'note'; md: string } // secondary information (grey)
  | { kind: 'footnote'; md: string } // smaller grey footnote (cost / evolution tree / easter eggs, sunk to the bottom)
  | { kind: 'quote'; text: string } // a quote block (a low-key summary)
  | { kind: 'callout'; tone: CalloutTone; md: string } // prominent banner (semantic tone) — each adapter colours or prefixes it its own way (Feishu uses <font>, Slack an emoji prefix)
  | { kind: 'divider' }
  | { kind: 'stats'; fields: string[] } // a row of side-by-side stat fields (size / confidence / cost…, each carrying its own markdown)
  | { kind: 'button'; button: CardButton } // a single callback button
  | { kind: 'buttonRow'; buttons: CardButton[] } // side-by-side callback buttons (force it through / one more revision)
  | { kind: 'decisionList'; items: DecisionItem[] } // open questions listed one by one (the question + options, with a star on the recommendation, plus the impact)
  | { kind: 'findingList'; findings: FindingLine[] } // residual review findings one by one (severity label + location/suggestion sub-lines) — the adapter colours the severity and greys the sub-lines
  | { kind: 'decisionForm'; slug: string; items: DecisionItem[]; action: string; round?: number; verdict?: boolean; submitText: string; notesLabel: string; notesPlaceholder: string } // a dropdown per question + (optionally) an overall verdict + a notes box + submit
  | { kind: 'goForm'; slug: string; pool: string[]; picked: string | null } // filing: a DRI dropdown + submit
  | { kind: 'petRow'; asset: string; voice: string; mentionId?: string }; // pet avatar + one line of dialogue; when mentionId is set, that person is @-mentioned (@PM)

// A provider-neutral description of one card to be sent. The adapter renders and sends it.
export interface CardModel {
  color: CardColor;
  title: string;
  subtitle?: string;
  blocks: CardBlock[];
}

// -- Inbound events (provider-neutral) -----------------------------------------
// An adapter's parseCardAction / parseMessage normalise its own raw events into the two shapes below,
// and listen's business dispatch recognises only these.

// A card callback (the PM or the maintainer clicked a button or submitted a form).
export interface InboundCardAction {
  type: 'card_action';
  action: string; // the callback's value.action
  slug: string; // the callback's value.slug
  value: Record<string, unknown>; // the full callback value (including passed-through fields such as round)
  formValues: Record<string, string>; // the form's form_value (ask_*/verdict/notes/assignee)
  operatorId?: string; // the triggering person's id within that IM (Feishu open_id / Slack user id)
}

// A channel message (the PM posting a PRD link).
export interface InboundMessage {
  type: 'message';
  chatId: string;
  senderId?: string;
  messageId?: string;
  text: string;
  // Requirement document links are often not in the plain text (a Feishu document share card, a rich
  // text post, Slack's blocks and attachments).
  // "Which structure the link is hiding in" is **messaging-provider** knowledge — the adapter digs
  // those structures out into opaque text blocks and puts them here; the core hands
  // `text + searchTexts` to the **document source registry** to be claimed (claimDocs, see
  // docs/index.ts).
  // What goes in is text blocks, not structured raw: that keeps the "look beyond the plain text"
  // fallback while leaking no provider raw shape back into the core.
  searchTexts?: string[];
  createTime: number;
  // Used by the channel intake gate (computed by the adapter from its own event; the core decides on
  // this basis whether the message enters the pipeline):
  // isGroup = whether this is a channel message (vs a p2p DM — a DM is inherently directed, so no
  //   mention is required);
  // mentionedBot = whether this bot was @-mentioned (the Feishu adapter reads the **server-populated
  //   mentions** on the event; the Slack adapter looks for <@BOTID> in the body).
  // mentionedBot = null means **the bot's identity could not be confirmed** (the provider side cannot
  //   obtain its own id) -> the core conservatively ignores it.
  // "Could not confirm" and "genuinely nobody mentioned it" must stay distinct — collapsing both into
  // false would quietly leave the whole channel intake wide open.
  // Omitted (an older provider, or a test that did not set it) is treated as non-channel and enters
  // the pipeline as before, leaving existing semantics unchanged.
  isGroup?: boolean;
  mentionedBot?: boolean | null;
}

export type InboundEvent = InboundCardAction | InboundMessage;
