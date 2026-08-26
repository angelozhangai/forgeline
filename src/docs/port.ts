// Thin document-layer seam — **DocSourcePort**: the one interface between the core and "where a
// requirement document comes from".
// The core knows only a provider-neutral DocRef (which source + a stable id within it). It does not
// know about Feishu wiki/docx, about a Notion page, or about a bare paragraph of text. Each source's
// adapter (see docs/<source>.ts) is responsible for claiming links, reading the body and — optionally
// — writing comments back.
//
// Why this seam is **shaped differently** from MessagingPort: IM is a **selection** (a deployment can
// have only one IM, or the approval trail forks), while document sources are a **registry** (one
// message may legitimately carry both a Feishu document and a Notion link, and both should be
// claimed). So there is no single port constant here, only a registry plus a set of content-addressed
// resolution rules (see docs/index.ts).

// A provider-neutral reference to one requirement document.
export interface DocRef {
  // Source id ('feishu' / 'plaintext' / 'notion'…). **Must not contain ':'** — the persisted key is
  // `<source>:<token>`.
  source: string;
  // Stable id within the source. Every URL variant of the same document (query parameters, trailing
  // slash, sharing suffix) must normalise to the same token, or PRD-level dedup — a red line — leaks.
  token: string;
  // A link a person can open. Some sources have none (plaintext does not) -> omitted. Used only for
  // display and for compatibility with the old prd_url dedup path.
  url?: string;
  // **Never persisted**: a carrier between claim() and read(). For sources where the message body
  // itself is the requirement and there is nothing to re-read (plaintext) — there is no remote to
  // fetch again, and the body exists only during this one pass.
  raw?: string;
}

export interface DocReadResult {
  ok: boolean;
  text: string;
  error?: string;
}

// Input to claim(): the searchable text surface of one IM message (the body plus any fallback text
// blocks the adapter dug out).
// Deliberately not an InboundMessage: the document layer should not know that IM exists, it only
// needs "some text to scan".
export interface DocClaimInput {
  text: string;
  searchTexts?: string[];
}

// Result of a document source's contract probe (provider-neutral, structurally identical to
// messaging's InboundProbe).
export interface DocProbe {
  available: boolean; // credentials present, a probe is possible
  ok: boolean; // envelope intact
  detail: string;
  raw?: string;
  kind?: 'auth' | 'drift'; // auth = credentials/permissions/network; drift = an envelope field is missing
}

export interface DocSource {
  readonly id: string;
  // A fallback source: it only gets a turn when **no** non-fallback source claimed, and at most one
  // entry is taken.
  // This is a **flag, not a position in the array** — position is too fragile: reorder the array once
  // and plaintext swallows every Notion link.
  readonly fallback?: boolean;

  // Claim the documents in a message that belong to this source (there may be several). Nothing
  // claimed -> an empty array.
  claim(input: DocClaimInput): DocRef[];
  // Build a ref for a body that arrives as **text with no document behind it**, bypassing whatever
  // product gating claim() applies. Optional, and only a fallback source can meaningfully implement it
  // (a source backed by a real document service has nothing to address).
  //
  // It exists because claim() answers "should a paragraph in a chat become a requirement", which is a
  // decision that costs money on every message, while a caller that already has an explicit body in hand
  // — the rehearsal typing one on the command line — is not asking that question at all. Separating the
  // two keeps the money gate where it belongs instead of forcing such a caller to switch it on.
  // Not ours, or not applicable -> null.
  refFromText?(text: string): DocRef | null;
  // Parse a link or bare token into this source's ref (the CLI's `--prd <url>` takes this path).
  // Not ours -> null.
  parseRef(urlOrToken: string): DocRef | null;
  // Read the body. On failure **report it faithfully** (the raw error goes into `error`); never return
  // an empty string pretending the read succeeded — callers park the session on that signal.
  read(ref: DocRef): Promise<DocReadResult>;
  // Write a comment back (optional capability). Method absent = this source does not support
  // write-back and the core silently skips it; method present but the call failed = logged
  // (best-effort, never blocks a gate).
  comment?(ref: DocRef, text: string): Promise<{ ok: boolean; error?: string }>;
  // Contract probe (optional): a read-only round trip verifying this source's own API envelope.
  // **Deliberately a local shape**, exactly as with messaging's InboundProbe — the document layer must
  // not import ProbeResult from llm/probes.ts (that would weld in the ProbeDep union type and a
  // docs -> llm dependency along with it). When the health page grows a "document source" row, the
  // thin mapping goes in llm/probes.ts, structurally identical to probeFeishu.
  // The core has no consumer yet: it is declared here so implementers have somewhere to put it now,
  // rather than the interface changing later.
  probe?(): Promise<DocProbe>;
}

// The persisted key: `<source>:<token>`. The source prefix is there because **tokens collide across
// sources** — with a bare token as the unique index, two sources will eventually produce the same
// string and two entirely unrelated requirements get judged duplicates.
export function formatRef(ref: DocRef): string {
  return `${ref.source}:${ref.token}`;
}

// Parse a persisted key back. Split on the **first** ':' — a token may contain further colons (a
// source id may not).
// No prefix / empty source / empty token all return null: better to make the caller handle it
// explicitly than to guess a source.
export function parseStoredRef(stored: string | null | undefined): DocRef | null {
  if (!stored) return null;
  const i = stored.indexOf(':');
  if (i <= 0 || i === stored.length - 1) return null;
  return { source: stored.slice(0, i), token: stored.slice(i + 1) };
}
