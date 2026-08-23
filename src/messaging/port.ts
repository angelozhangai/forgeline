// Thin transport seam — **MessagingPort**: the one interface between the core and a concrete IM
// provider (Feishu / Slack).
// Outbound: the core hands over a provider-neutral CardModel (or a simple title + lines) and the
// adapter renders it into its own card format and sends it.
// Inbound: the adapter parses its own raw events into a provider-neutral InboundEvent and hands that
// back to the core for dispatch.
//
// Adding another IM means writing one more adapter implementing this interface; the core
// (notify/listen/worker/actions) does not change by a line — which is the entire point of the seam.
import type { CardModel, CardColor, InboundCardAction, InboundMessage } from './model.ts';

// Callbacks for the inbound long-lived connection (supplied by the core, invoked by the adapter when
// it receives one of its own raw events). `raw` is a provider-neutral opaque Record — the core then
// hands it to parseCardAction/parseMessage to be normalised into InboundCardAction/InboundMessage
// (keeping the existing parse-in-core dispatch: the adapter only establishes the connection and
// carries raw events across, and never leaks the provider SDK or the channel lifecycle into the core).
export interface InboundHandlers {
  onCardAction(raw: Record<string, unknown>): void;
  onMessage(raw: Record<string, unknown>): void;
  onError(reason: string): void; // connection error (marks offline)
  onReconnected(): void; // reconnected (marks online + backfills messages from the outage)
}

// Handle on the inbound connection. connect() establishes it (a failed first connect rejects, leaving
// the core to decide whether to degrade to periodic ticks only).
// close() is optional: it shuts this connection down **cleanly** (a provider may have more than one
// alive at once — a planned reconnect overlaps them briefly).
// The daemon is killed by a signal today and does not take this path, but the adapter's shutdown logic
// must be **reachable by someone**, or it is code that will never run and never be verified. The local
// acceptance loop is what closes the connections through it.
export interface InboundChannel {
  connect(): Promise<void>;
  close?(): void;
}

// Result of the inbound transport's contract probe (provider-neutral): run the cheapest possible
// read-only round trip against the provider's own IM API and assert the envelope fields we depend on
// are still there. available = credentials present and a probe is possible; ok = the envelope is
// intact. Implemented inside the adapter (Feishu's im/v1/messages, Slack's conversations.history and
// similar details do not leak into the llm/health layers); probeIm in llm/probes is a thin mapping.
export interface InboundProbe {
  available: boolean;
  ok: boolean;
  detail: string;
  raw?: string;
  // Attribution when !ok (same as ProbeResult.kind, passed through by probeIm to the health/contract
  // alert routing): auth = credentials/permissions/network (log in again, check scopes, join the
  // channel — not a contract.ts edit); drift = an envelope field is missing (a contract.ts edit).
  kind?: 'auth' | 'drift';
  // **Remediation guidance** for kind='auth' ("go here, change this"). Supplied by the adapter rather
  // than hardcoded in the core: "how do I renew a Feishu token" and "which scope does Slack need" are
  // provider knowledge, and one hardcoded copy in the core means speaking for every provider — plus
  // an edit to the core every time a provider is added. When absent, health/contract falls back to a
  // generic sentence.
  authFix?: string;
}

export interface MessagingPort {
  // Provider identifier ('feishu' / 'slack' / …). The core uses it for **display and logging only**
  // (health check row names, startup logs) and must never branch business logic on it — the moment
  // `if (port.id === 'feishu')` appears, this seam has been opened for nothing.
  readonly id: string;

  // -- Outbound: decision / notification cards --
  // Direct-message card to the maintainer (arbitration, request a design, file a requirement, retry a
  // failure…). Returns whether it was delivered (the caller decides how to degrade on failure).
  sendDmCard(card: CardModel): Promise<boolean>;
  // Simple text card (title + markdown lines + colour) — drift/health alerts, in-progress receipts and
  // other cases with no form.
  sendDmText(title: string, lines: string[], color: CardColor): Promise<boolean>;

  // -- Outbound: channel status card (a reply to the PM's message, edited in place throughout) --
  // Reply to a message with a new channel card; returns the new card's messageId (persisted as
  // status_msg_id).
  replyGroupCard(replyToMessageId: string, card: CardModel): Promise<string | null>;
  // Post straight to the channel (when there is no intake message to reply to); returns the messageId.
  sendGroupCard(chatId: string, card: CardModel): Promise<string | null>;
  // Edit an existing channel card in place (same messageId).
  editGroupCard(messageId: string, card: CardModel): Promise<boolean>;

  // -- Outbound: channel webhook fallback (channel-side degradation when a bot DM was not delivered;
  //    used for non-error notifications only) --
  postWebhook(title: string, lines: string[], color: CardColor): Promise<boolean>;

  // -- Inbound: parse the provider's own raw events into provider-neutral ones (unrecognised -> null) --
  parseCardAction(raw: Record<string, unknown>): InboundCardAction | null;
  parseMessage(raw: Record<string, unknown>): InboundMessage | null;

  // -- Inbound: the long-lived connection (the adapter builds the channel and sends/receives; the core
  //    touches no provider SDK and no channel lifecycle) --
  // Whether inbound transport is configured (credentials present). Not configured -> the core degrades
  // to periodic ticks only (no card buttons, no channel message intake).
  inboundConfigured(): boolean;
  // Start the inbound connection: the adapter builds the channel, forwards its own raw events to
  // `handlers`, and returns a connectable handle.
  startInbound(handlers: InboundHandlers): InboundChannel;

  // -- Inbound: history backfill (channel messages sent while the connection was down; providers do
  //    not re-deliver them on reconnect) --
  // "Which channels to read" is provider-specific configuration (Feishu's FEISHU_WATCH_CHATS, Slack's
  // SLACK_WATCH_CHANNELS…), and each adapter reads its own env; the core only takes this list of ids
  // to seed the cursors.
  watchedChats(): string[];
  // Fetch a channel's history **after** sinceMs (a millisecond watermark), returned in ascending time
  // order. Pagination, authentication and error handling all live inside the adapter: this is a
  // best-effort channel (on failure, return what was retrieved and log) and must never throw — a
  // failed backfill should not take the periodic loop down with it.
  // Boundary semantics are re-checked by the core: the adapter may return the boundary entry itself
  // because start_time has only second precision, and the core filters again by createTime.
  listHistorySince(chatId: string, sinceMs: number): Promise<InboundMessage[]>;

  // Inbound transport contract probe: a read-only round trip verifying the provider's IM API envelope
  // (Feishu im/v1/messages pagination fields and the like).
  probe(): Promise<InboundProbe>;
}
