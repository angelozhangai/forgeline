# Pluggable Messaging Providers + Pluggable Document Sources

> **Implementation source of truth** for the epic "swap the IM provider and the requirement-document
> source independently, without touching the core". Engineering discipline: [../AGENTS.md](../AGENTS.md).
> Existing seam pattern: [MessagingPort](../src/messaging/port.ts). Related: [architecture-control-plane-split.md](architecture-control-plane-split.md).
>
> Status: **Phase 0 not started.** Every phase must leave `npm run ci` fully green and — unless the
> phase explicitly says otherwise — must not change behaviour under the default (Feishu) configuration.

---

## 0. Why this epic exists

Forgeline's IM transport is already behind a provider-agnostic seam (`MessagingPort` + semantic
`CardModel`), and that seam is machine-guarded by [test/arch-boundary.test.ts](../test/arch-boundary.test.ts).
An audit of the actual coupling found the seam holds — with four residual leaks:

| # | Leak | Where |
| --- | --- | --- |
| 1 | ~~**The document layer was never abstracted at all.**~~ **Closed in Phase 1** — `DocSourcePort` + registry; the core only ever sees a `DocRef`. | [src/docs/port.ts](../src/docs/port.ts), [src/docs/index.ts](../src/docs/index.ts) |
| 2 | ~~`extractFeishuLinks` — a Feishu URL regex — lives in the core.~~ **Closed in Phase 1** — the regex moved into the Feishu source; the core calls `claimDocs`. | [src/docs/feishu.ts](../src/docs/feishu.ts) |
| 3 | ~~**Offline backfill bypasses the port entirely**; `MessagingPort` has no history method.~~ **Closed in Phase 0** — the loop is core-side, the API call is behind `listHistorySince`. | [src/messaging/backfill.ts](../src/messaging/backfill.ts) |
| 4 | ~~Feishu names baked into config, DB columns, probe enum and health labels.~~ **Closed** — DB columns in Phase 1 (migration v1), probe enum + health labels in Phase 4 (migration v2). | — |

Leak 3 is why README's "A Slack adapter is one file away, with the core untouched" was a slight
overclaim when this was written. Leaks 1–2 were a whole second seam that had never been opened.
Phases 0–3 closed 1–3 and shipped the Slack adapter; the claim now holds literally — Slack landed
without a single core file changing behaviour for it.

**Goal**: two independent, pluggable axes — IM provider and document source — with Slack shipped as the
second IM provider and a `plaintext` document source that lets Slack run with no document service at all.

---

## 1. Decision summary (settled)

1. **Two orthogonal seams, deliberately different shapes.** `MessagingPort` = *selection* (exactly one
   active provider). `DocSourcePort` = *registry* (N registered, resolved per message). See §2 for why.
2. **Slack transport is hand-written with zero new dependencies**: raw `fetch` for the Web API, Node's
   native `WebSocket` (present in Node ≥ 22; this repo requires ≥ 24) for Socket Mode. This matches the
   existing Feishu raw layer — [dm.ts](../src/feishu/dm.ts) / [group.ts](../src/feishu/group.ts) /
   [notify.ts](../src/feishu/notify.ts) are all hand-written `fetch`; only the long connection uses the
   Lark SDK. It also honours AGENTS.md's restrained-dependency rule.
3. **`plaintext` is the first non-Feishu document source**, shipping in the same epic as Slack. The
   requirement body *is* the IM message. Slack must not be blocked on building a Notion/Google Docs
   adapter; those become drop-in additions later.
4. **The provider selection point stays a module-load constant** (`FORGE_MESSAGING_PROVIDER`), not a
   downstream-overridable hook. This preserves the property [src/ext/port.ts](../src/ext/port.ts) relies
   on. **Unknown provider id → hard error, never a silent fallback to Feishu.**
5. **The riskiest Slack assumptions get a throwaway spike before production code** (Phase 3.0). The phasing contains the blast radius: Phases 0–2 are seam work that stands on its own regardless of which IM ships, so a failed assumption only redesigns Phase 3.
6. **Each phase ships green and behaviour-preserving.** No phase is allowed to change what a Feishu
   deployment does, except where explicitly called out (see §6, Open decision D1).

---

## 2. The two seams, and why they are shaped differently

```
                    ┌──────────────────────────────────────────────┐
  human interaction │  MessagingPort   —  SELECTION, exactly one   │  feishu | slack
  (cards, buttons)  │  src/messaging/port.ts, index.ts             │
                    └──────────────────────────────────────────────┘
                    ┌──────────────────────────────────────────────┐
  requirement text  │  DocSourcePort   —  REGISTRY, N registered   │  feishu | plaintext
  (read + comment)  │  src/docs/port.ts, index.ts                  │  (+ notion | gdocs | confluence)
                    └──────────────────────────────────────────────┘
```

The asymmetry is not stylistic. It falls out of one question: **how many can be true at once for a
single deployment?**

- **One IM.** A deployment talks to its team in one place. Two live IM providers would fork the approval
  trail — the same GO clickable in two places, operator→shortcode mapping needing per-provider
  namespacing, two sources of truth for `status_msg_id`. Not worth it. So: pick one at startup.
- **Many document sources.** A PM in one Slack channel can paste a Notion link today and a Google Doc
  tomorrow. The core cannot know in advance which. So resolution must be **content-addressed**: ask each
  registered source "do you claim this message?".

---

## 3. `DocSourcePort` — the new seam

```ts
// src/docs/port.ts
export interface DocRef {
  source: string;  // adapter id — 'feishu' | 'plaintext' | 'notion' …
  token: string;   // stable id within that source (all URL variants normalise to one token)
  raw?: string;    // NOT persisted: in-request carrier from claim() to read() (plaintext body)
}

export interface DocSource {
  readonly id: string;
  // Fallback sources are only consulted when no primary source claimed the message.
  readonly fallback?: boolean;

  // ── recognise ──
  // Claim 0..N requirement documents out of one inbound message.
  // Link-type sources scan for their own URLs; plaintext returns the message itself as one doc.
  claim(msg: { text: string; searchTexts?: string[] }): DocRef[];
  // Normalise one URL / bare token into a stable ref. Not mine → null. (CLI `forge add --prd <url>`.)
  parseRef(urlOrToken: string): DocRef | null;

  // ── read ──
  read(ref: DocRef): Promise<{ ok: boolean; text: string; error?: string }>;

  // ── write back (optional capability) ──
  // Machine-review / confirmation comments. A source without comments simply omits this;
  // the core silently skips it (write-back is best-effort and never blocks the pipeline).
  comment?(ref: DocRef, text: string): Promise<{ ok: boolean; error?: string }>;

  // ── contract probe (optional; wired in a later phase) ──
  probe?(): Promise<ContractProbe>;
}
```

### Resolution rules (in `src/docs/index.ts`, the single wiring point)

```ts
// Primaries union — today's semantics: N links in one message → N requirements.
// Fallback only when the union is empty, capped at 1 (a message is at most one plaintext requirement).
export function claimDocs(msg): DocRef[] {
  const primary = dedupe(REGISTERED.filter(s => !s.fallback).flatMap(s => s.claim(msg)));
  if (primary.length) return primary;
  return REGISTERED.filter(s => s.fallback).flatMap(s => s.claim(msg)).slice(0, 1);
}
```

`fallback` is a **flag, not a list position**. Position would be fragile: someone reorders the array and
plaintext swallows every Notion link ever pasted.

### Why `read()` being one-shot is safe

Verified against the code: `addPrd` reads the document exactly once and writes it to
`<sessionLogDir>/prd.txt`, storing `prd_text_path`. Every downstream consumer
([gateA.ts](../src/gates/gateA.ts), [gateALoop.ts](../src/gates/gateALoop.ts),
[prdTruth.ts](../src/gates/prdTruth.ts)) reads that file — **nothing ever re-reads the source document.**
So a source that cannot be re-read (plaintext) is a first-class citizen, not a degraded one.

### Dedup: the namespaced ref

PRD-level dedup is a red line (`idx_session_doc_token` unique partial index). With multiple sources, a
bare token can collide across sources. The persisted key therefore becomes `"<source>:<token>"` in a
renamed `doc_ref` column, with the unique index following it. For `plaintext`, the token is a hash of
the normalised body — so re-pasting identical text correctly hits the dedup path and answers
"this requirement has already been reviewed", while an edited body is honestly a new requirement.

---

## 4. `MessagingPort` — what Slack forces us to add

Two new methods; everything else on the interface already fits.

```ts
readonly id: string;                        // 'feishu' | 'slack' — for health labels and logs
watchedChats(): string[];                   // adapter reads its own env (FEISHU_WATCH_CHATS / SLACK_WATCH_CHANNELS)
listHistorySince(chatId: string, sinceMs: number): Promise<InboundMessage[]>;  // ascending
```

`listHistorySince` closes leak 3. The **loop** (cursor seeding/advancing, claiming docs, `addPrd`,
re-entrancy guard) moves into a new core-side `src/messaging/backfill.ts` — provider-neutral and
unit-testable with no network. The adapter keeps only the API call.

### Findings that mean the core does **not** change

- **Zero Feishu markup leaks into the core.** A sweep for `<font>` / `<at>` / `lark_md` outside the
  adapter returns nothing. The core's prose blocks carry portable markdown only (`**bold**`). The
  worry recorded in [messaging/feishu.ts](../src/messaging/feishu.ts)'s header — "the one controlled leftover" — turns
  out not to exist. Slack needs a plain markdown → mrkdwn conversion, not a Feishu-dialect parser.
- **`status_msg_id` / `intake_msg_id` are fully opaque to the core** — only stored and handed back to
  `port.*`. Slack's `chat.update` needs *both* channel and `ts`, which the `editGroupCard(messageId, …)`
  signature does not carry; the adapter therefore returns a composite `"C123:1712345678.000100"` as its
  message id and splits it on the way back in. **No port signature change, no core change.**
- **`operatorId` is an opaque string** through [messaging/operators.ts](../src/messaging/operators.ts).
  Slack `U…` ids map through the same `permissions.yaml` `operators` table unchanged (comment wording only).

### The one real UX difference: forms

**Slack has no in-message form-with-submit.** `input` blocks are valid only in modals and Home tabs;
selects placed in `actions` blocks fire an interaction per selection. The `decisionForm` block also
needs a free-text `notes` field, which has no in-message representation at all.

Mapping: **`decisionForm` / `goForm` → a summary `section` + one button → `views.open` modal → a single
`view_submission` carrying every value at once.** `{action, slug, round}` rides in the modal's
`private_metadata`.

This is entirely adapter-internal. `InboundCardAction.formValues` — the core-facing contract — is
unchanged. **The existing seam survives its first real test.**

### CardBlock → Block Kit

| CardBlock | Feishu | Slack |
| --- | --- | --- |
| `text` | `markdown` | `section` + mrkdwn |
| `note` | grey markdown | `context` |
| `footnote` | small grey markdown | `context` |
| `quote` | `> …` | `section` with `>` |
| `callout` | `<font color>` | `section` with emoji prefix (`:rotating_light:` / `:warning:` / `:information_source:`) |
| `divider` | `hr` | `divider` |
| `stats` | `column_set` weighted | `section` + `fields[]` (2-col, max 10) |
| `button` / `buttonRow` | callback button(s) | `actions` + `button`, `action_id` + JSON `value` |
| `decisionList` / `findingList` | per-item markdown | per-item `section` mrkdwn |
| **`decisionForm` / `goForm`** | inline `form` | **summary + button → modal → `view_submission`** |
| `petRow` | `img` + text | emoji + mrkdwn (Slack image blocks need a public URL) |

mrkdwn conversion needed: `**b**` → `*b*`, `[t](u)` → `<u\|t>`, list/heading normalisation.

*Possible later refinement, explicitly out of scope:* `goForm` has no free-text field, so it could stay
inline using the `state.values` that Slack includes on `block_actions`. One click instead of two, at the
cost of a second inbound parsing path. Ship the modal first.

---

## 5. Phases

Ordering principle: each phase ends green, and Feishu behaviour is unchanged unless stated.

### Phase 0 — close the transport seam (no new provider)

| | Task | Files |
| --- | --- | --- |
| 0.1 | Add `id`, `watchedChats()`, `listHistorySince()` to `MessagingPort`; implement on the Feishu adapter | `messaging/port.ts`, `messaging/feishu.ts` |
| 0.2 | Move the backfill **loop** into a core-side `messaging/backfill.ts`; the Feishu side keeps only the `im/v1/messages` call | new `messaging/backfill.ts`, `feishu/backfill.ts` → `feishu/history.ts` |
| 0.3 | `daemon/listen.ts` stops importing `../feishu/backfill.ts` | `daemon/listen.ts` |
| 0.4 | Drop the `daemon/listen.ts` entry from the arch-boundary whitelist | `test/arch-boundary.test.ts` |

**DoD**: whitelist down from 3 entries to 2; identical chats still backfilled; `npm run ci` green;
`TEST_COUNT_FLOOR` raised.

**Landed** ([#9](https://github.com/angelozhangai/forgeline/pull/9)). Two notes for later phases:

- **D1 stays open, but the evidence is now cheap to collect.** The adapter maps `mentions` faithfully
  (absent field → `null`, which is *not* the same as "nobody was mentioned"), and the core loop
  deliberately does not read it. Whether Feishu history items actually carry the field is one live-tenant
  run away, and `test/messaging-feishu-history.test.ts` already pins both branches.
  *(Closed in [#19](https://github.com/angelozhangai/forgeline/pull/19) — the faithful `null` mapping is
  what made the three-state gate possible. See D1 in §6.)*
- **Backfilled sessions still lose `posterId` / `intakeMsgId`.** The loop now *sees* the full
  `InboundMessage`, so passing them through is a two-line change — but it would alter Feishu behaviour
  (offline-registered sessions would start replying in-thread), and Phase 0 was a pure refactor. Follow-up.
  *(Closed in [#17](https://github.com/angelozhangai/forgeline/pull/17), which also found that a failed
  `replyGroupCard` dropped the status card entirely instead of degrading to a channel post.)*

### Phase 1 — `DocSourcePort`

| | Task | Files |
| --- | --- | --- |
| 1.1 | Port + registry (`claim`/`parseRef`/`read`/`comment?`/`probe?`, primary-union + fallback) | new `docs/port.ts`, `docs/index.ts` |
| 1.2 | Feishu doc adapter — absorbs `feishu/doc.ts`, `workspace.ts`'s `feishuRead`/`feishuReadDocxRaw`/`feishuCommentAdd`/`feishuUserToken`, and the `util/links.ts` regex | new `docs/feishu.ts` |
| 1.3 | Rewire the core: `intake.ts` takes a `DocRef`; `gateA.ts`/`actions.ts` call `docComment(s, text)`; `listen.ts` calls `claimDocs(m)` | `intake.ts`, `gates/gateA.ts`, `actions.ts`, `daemon/listen.ts` |
| 1.4 | **One migration for every Feishu-named session column** — `feishu_doc_token` → `doc_ref` (values prefixed `feishu:`, unique index follows), `feishu_chat_id` → `chat_id`, `poster_open_id` → `poster_id`. The **first** `MIGRATIONS` entry. | `store/db.ts`, `store/schema.sql`, `store/sessions.ts`, `store/port.ts`, `types.ts`, `notify.ts`, `intake.ts` |
| 1.5 | Arch-boundary: drop `intake.ts`, allow only `docs/feishu.ts` to touch Feishu docs | `test/arch-boundary.test.ts` |

**DoD**: whitelist down to `messaging/feishu.ts` + `docs/feishu.ts`; Feishu behaviour identical; an
upgraded old DB has every `doc_ref` prefixed and still dedups.

**Landed** ([#10](https://github.com/angelozhangai/forgeline/pull/10)). Three things worth carrying forward:

- **The whitelist went to one entry, not two.** `docs/feishu.ts` needs no exemption at all — it talks to
  the project's `feishu-doc.js` and to `docx/v1`, never to `src/feishu/*` or the lark SDK. A *second*
  boundary rule replaced it: nothing outside `src/docs/` may import a concrete source, only `docs/index.ts`.
- **`schema.sql` is the current baseline, not the historical origin.** A fresh DB is detected before the
  schema is applied and stamped straight to the latest `user_version`, so historical migrations only ever
  run against pre-existing databases. Without this, v1's `RENAME COLUMN` would have thrown on every new install.
- **The unique index is rebuilt *after* migrations, not inside v1.** A legacy DB with duplicate tokens would
  otherwise fail the index creation, roll back the whole migration, and refuse to start.

### Phase 2 — `plaintext` document source

| | Task | Files |
| --- | --- | --- |
| 2.1 | `fallback: true`; normalise body (trim, collapse whitespace, strip bot mention) → content-hash token; `read` from `ref.raw`; no `comment` | new `docs/plaintext.ts` |
| 2.2 | Minimum-substance bar so "ok thanks" never becomes a requirement | `docs/plaintext.ts` |
| 2.3 | Register it (fallback slot) | `docs/index.ts` |

**DoD**: a session can be created from a bare IM message with no document service configured;
re-pasting identical text hits the dedup path.

**Landed** ([#11](https://github.com/angelozhangai/forgeline/pull/11)). Two deviations from the plan, both deliberate:

- **It ships default-off**, behind `runtime.yaml` `doc_sources.plaintext.enabled`. Registering it
  unconditionally would change existing Feishu deployments in the most expensive possible direction: today
  an @-mention with no document link is ignored, and afterwards it would create a requirement and run
  Gate A. The @-mention gate exists precisely to stop casual messages from costing money; turning
  plaintext on silently would reopen that hole from the other side.
- **It exposed a real bug in the Feishu source and fixed it.** `parseRef` accepted *any* string without a
  `/` as a bare token, so a whole sentence of Chinese became a Feishu doc ref — a requirement that can
  never be read, and a message intercepted before the fallback source ever got a turn. Bare tokens now
  have to look like tokens (`[A-Za-z0-9]{10,}`).

### Phase 3 — Slack adapter (the focus)

| | Task | Files |
| --- | --- | --- |
| 3.0 | **Spike first (throwaway branch)** — prove that a `views.open` modal carries `{action, slug, round}` through `private_metadata` and returns every field in one `view_submission`, and that hand-rolled Socket Mode survives a disconnect | — |
| 3.1 | Web API layer: `fetch` + `xoxb` token + normalised `{ok,error}` + rate-limit backoff | new `slack/web.ts` |
| 3.2 | Socket Mode: `apps.connections.open` → native `WebSocket` → envelope ack + ping + exponential reconnect → `InboundHandlers` | new `slack/socket.ts` |
| 3.3 | Adapter: Block Kit rendering, mrkdwn conversion, `parseCardAction`/`parseMessage`, composite `"channel:ts"` message ids | new `messaging/slack.ts` |
| 3.4 | Modal round-trip: `views.open` + `private_metadata` + `view_submission` → `formValues` | new `slack/modal.ts` |
| 3.5 | Selection point: `FORGE_MESSAGING_PROVIDER`, **hard error on unknown id** | `messaging/index.ts` |
| 3.6 | Symmetric arch-boundary guard for `slack/` (only `messaging/slack.ts` may import it) | `test/arch-boundary.test.ts` |
| 3.7 | `listHistorySince` + `probe` via `conversations.history` | `messaging/slack.ts` |
| 3.8 | Env + doctor: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_DM_USER_ID`, `SLACK_WATCH_CHANNELS`, `SLACK_WEBHOOK_URL`, `SLACK_BOT_USER_ID` | `config.ts`, `index.ts`, `config/forge.env.example` |

**DoD**: with `FORGE_MESSAGING_PROVIDER=slack`, the full loop runs — message in → Gate A card → PM
answers via modal → GO → issues created. Feishu regression-free. Rendering covered by unit tests in the
style of [test/messaging-feishu.test.ts](../test/messaging-feishu.test.ts).

**Landed** ([#12](https://github.com/angelozhangai/forgeline/pull/12)).

**What the spike (3.0) actually settled — and what it could not.** No Slack workspace was available, so
the spike was split:

- **Socket Mode: verified for real.** A throwaway script stood up a local WebSocket server (`node:http` +
  a hand-computed `Sec-WebSocket-Accept`, no external network) and drove Node's native `WebSocket`
  through connect → receive envelope → ack → server-side hard disconnect → reconnect. It passed, and it
  surfaced a detail worth the whole exercise: an abrupt disconnect fires **`error` and then `close`**.
  Treating both as reconnect triggers opens two connections, and every envelope then arrives twice. The
  production channel settles each connection exactly once, and a test pins that sequence.
- **Modal round-trip: not verified live.** `private_metadata` carrying `{action, slug, round}` and one
  `view_submission` returning every field is implemented against the documented payload shapes and pinned
  by a build → simulated-submit → parse round-trip test. That validates *our* handling, not Slack's
  behaviour. It remains the one assumption needing a real workspace.

**Phase 3.1 — the local acceptance loop ([#14](https://github.com/angelozhangai/forgeline/issues/14)).**
The spike above was a throwaway script; what it proved died with it. Phase 3.1 turns the same idea into
two permanent parts of the suite, and shrinks "needs a real workspace" down to what actually needs one.

- **[test/slack-live-loop.test.ts](../test/slack-live-loop.test.ts) — the whole round trip, nothing
  mocked.** A fake Slack (`node:http` Web API + a hand-written WebSocket server, zero dependencies) sits
  opposite the *real* `slack/web.ts` and `slack/socket.ts`, and the loop runs end to end:
  `apps.connections.open` → wss handshake → envelope → ack → `chat.postMessage` → button click →
  `views.open` → `view_submission` → the core's `{action, slug, round, formValues}`. It also drives a
  planned `disconnect` (new connection opened before the old one closes, no false alarm to the core) and
  a hard disconnect (one reconnect, `onReconnected` fired) over a real socket. What this catches that a
  unit test cannot: the form encoding that read methods require, the ack frame really being a frame, and
  the context really surviving `private_metadata`.
- **[test/slack-blockkit.test.ts](../test/slack-blockkit.test.ts) — the structural gate.** Slack answers
  a malformed payload with `invalid_blocks` and *no* indication of which block or field; the operator
  sees "the card never appeared" or "the button does nothing". Those failures are structural, so they are
  decidable locally: [src/slack/blockkit.ts](../src/slack/blockkit.ts) holds Slack's documented limits as
  the single source of truth, and the test runs the validator over every card Forge can emit (each
  `NotifyKind`, each `State`) plus deliberately hostile content — emoji sitting exactly on every
  truncation boundary, empty strings, oversize text. The same validator runs at runtime *only after*
  Slack has already said no, turning `invalid_blocks` into "block 3's `section.text` is empty".

**What is still tenant-only, after 3.1.** Only Slack's own behaviour: that a real `views.open` accepts
this view, that `view_submission` really returns `private_metadata` plus every `state.value` in one
payload, that the planned `disconnect` really arrives about every 30 minutes, and that acks land inside
the 3-second window under real latency. Everything upstream of those is now machine-checked on every CI
run.

**The modal's hidden state problem.** Slack forms live in a modal, but the modal's *contents* (which
decisions, which DRI pool) are only known when the card is rendered — and the click can come much later.
The adapter caches the built view in memory at render time. A daemon restart empties that cache while the
card is still sitting in Slack, so the fallback matters more than the happy path: instead of a button that
does nothing when clicked, it opens a degraded free-text modal that still carries the full
`private_metadata` context. The answer is less structured; it still reaches the right requirement.

### Phase 4 — de-Feishu the names + docs

> The `session` column renames moved into Phase 1: that phase already rewrites `store/*` for `doc_ref`, so the same migration covers them at nearly zero cost. A separate cosmetic tail phase is the classic casualty of a long tracking issue.

| | Task | Files |
| --- | --- | --- |
| 4.1 | `ProbeDep` `'feishu'` → `'im'` + `UPDATE contract_probe SET dep='im' WHERE dep='feishu'` | `llm/probes.ts`, `health/contract.ts`, `store/db.ts` |
| 4.2 | Health label from `port.id` instead of a hardcoded "Feishu long connection"; doctor split per provider | `health/check.ts`, `index.ts` |
| 4.3 | README / AGENTS.md / deploy docs: Slack setup + how to register a document source | `README.md`, `AGENTS.md`, `deploy/` |

**DoD**: `grep -ri feishu src/` matches only `src/feishu/`, `src/messaging/feishu.ts`, `src/docs/feishu.ts`.

**Landed** ([#13](https://github.com/angelozhangai/forgeline/pull/13)). The DoD as written is not quite
achievable, and pretending otherwise would be worse than restating it. Three categories legitimately keep
the name:

1. **The wiring points** — `messaging/index.ts` maps `'feishu' → feishuPort`, `docs/index.ts` registers
   `feishuDocs`. Naming providers is what a selection point and a registry are *for*.
2. **`FEISHU_*` env keys** in `config.ts`'s `Env` — they are the Feishu provider's actual variable names.
3. **Migration SQL** — `v1` renames `feishu_doc_token`, `v2` rewrites `dep = 'feishu'`. A migration that
   could not name the old thing could not migrate it.

Everything else went: `ProbeDep` `'feishu'` → `'im'` (with migration v2 rewriting stored rows), the health
label now reads `${port.id} long connection`, and the daemon's user-facing log lines name the live provider instead
of assuming one.

Two changes worth calling out because they are behavioural, not cosmetic:

- **Auth-failure remediation moved into the adapter** (`InboundProbe.authFix`). It used to be a core lookup
  table keyed by dep. "How do I fix this token" is provider knowledge; keeping it in the core meant every
  new provider required a core edit, which is exactly what these seams exist to prevent.
- **`intake` no longer falls back to `FEISHU_REVIEW_CHAT_ID`** for a manually-added PRD's chat; it uses
  `port.watchedChats()[0]`. Same intent, provider-neutral — but note that a deployment setting *both*
  `FEISHU_WATCH_CHATS` and a different `FEISHU_REVIEW_CHAT_ID` will now anchor manual adds to the first
  watched chat rather than the review chat.

---

## 6. Open decisions

**D1 — does offline backfill get the @-mention gate?** ~~Live group messages must @ the bot before
entering the pipeline (an anti-cost measure: casually shared docs must not trigger Gate A). Backfill
does **not** apply that gate today, so it is a genuine hole. Unifying is the correct fix, but only if
Feishu's `im/v1/messages` history items actually carry the server-filled `mentions` array — otherwise
`mentionedBot` would be `null`, the core would conservatively ignore everything, and backfill would
silently stop working. **Default: preserve today's behaviour in Phase 0** (no silent change), verify the
history envelope during implementation, and unify in a separate follow-up if the field is available.~~

**Resolved** ([#15](https://github.com/angelozhangai/forgeline/issues/15) / [#19](https://github.com/angelozhangai/forgeline/pull/19)) — **yes, and without waiting for the tenant dump.**

The question was framed as a blocking one: go look at a live Feishu history item, *then* decide. That
framing was wrong, because it assumed both paths must treat `mentionedBot === null` the same way. They
should not. The two failure modes are not symmetric:

| | live message | backfilled history item |
| --- | --- | --- |
| cost of wrongly admitting | one wasted Gate A | one wasted Gate A |
| cost of wrongly ignoring | the message is still in the chat; @ again | **the requirement is gone, silently** |

So the gate became a **three-state predicate** ([src/messaging/gate.ts](../src/messaging/gate.ts)) shared by
both paths, and only the third state diverges: live ignores what it cannot confirm, backfill admits it.
That is a strict improvement for every provider that *does* report mentions (Slack reads `<@BOTID>` from
history text; Feishu too, if the field is there) and an exact no-op for any provider that does not — so
it needed no tenant answer to land.

The observation the issue asked for still happens, just automatically: an unconfirmable message now
raises one summary `warn` per backfill round naming the provider. Running the daemon answers the original
question; nobody has to hand-dump an API payload. If that line never appears on a Feishu deployment, the
offline gate is live there too and D1 is fully closed for Feishu as well.

**D2 — where does `FORGE_MESSAGING_PROVIDER` get read?** `process.env` first, then a direct minimal read
of `forge.env`. Deliberately *not* via `loadConfig()`: calling it at module scope in a module this
widely imported would drag yaml+zod validation into every import and risks test brittleness.
Extract the existing `loadEnvFile()` parser from [config.ts](../src/config.ts) and share it.

---

## 7. Red lines (unchanged by any phase)

- **Hooks notify, never intercept**; **core commands win**; **present-but-unloadable → hard error.**
  The new provider selection point inherits the last one: an unknown `FORGE_MESSAGING_PROVIDER` must
  throw, never fall back to Feishu.
- **The state machine and transition table stay non-extensible.** Nothing here touches them.
- **PRD-level dedup survives the column rename.** The unique partial index moves with `doc_ref`; the
  concurrent-insert race path in `addPrd` keeps its last-gate role.
- **No silent failures.** A document source that cannot read parks the session with the raw error, same
  as today. A source without `comment` is a *capability gap*, silently skipped — write-back was always
  best-effort — but a `comment` that *exists and fails* is still logged.
- **This repo ships no `ext/`**, and the suite must pass with none present.

---

## 8. Progress

Tracked in [#2](https://github.com/angelozhangai/forgeline/issues/2).

| Phase | Issue | Status |
| --- | --- | --- |
| 0 — transport seam | [#3](https://github.com/angelozhangai/forgeline/issues/3) | ✅ done |
| 1 — `DocSourcePort` | [#4](https://github.com/angelozhangai/forgeline/issues/4) | ✅ done |
| 2 — plaintext source | [#5](https://github.com/angelozhangai/forgeline/issues/5) | ✅ done |
| 3 — Slack adapter | [#6](https://github.com/angelozhangai/forgeline/issues/6) | ✅ done |
| 4 — naming + docs | [#7](https://github.com/angelozhangai/forgeline/issues/7) | ✅ done |
