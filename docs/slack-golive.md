# Slack go-live — the four things only a real workspace can settle

Everything about the Slack adapter that could be decided locally **has been**, and is in CI:

- [test/slack-live-loop.test.ts](../test/slack-live-loop.test.ts) runs the whole round trip against a
  dependency-free fake Slack (`node:http` Web API + a hand-written WebSocket server) with the **real**
  [src/slack/web.ts](../src/slack/web.ts) and [src/slack/socket.ts](../src/slack/socket.ts) on the other side:
  `apps.connections.open` → handshake → envelope → ack → `chat.postMessage` → `block_actions` → `views.open`
  → `view_submission` → the core receives `{action, slug, round, formValues}`, plus a planned reconnect and a
  hard drop.
- [test/slack-blockkit.test.ts](../test/slack-blockkit.test.ts) validates **every card Forge can send** (every
  `NotifyKind` × every `State`) against Slack's documented limits, with hostile content — an emoji sitting
  exactly on a truncation boundary, empty strings, over-long text.

None of that can prove what Slack's own servers do. **Four questions are left, and only a real workspace
answers them:**

1. a real `views.open` accepts this view (all the local gate guarantees is that it is structurally valid);
2. one `view_submission` really returns `private_metadata` **plus** all of `state.values`;
3. the planned `disconnect` (`refresh_requested`) really arrives about every half hour;
4. an ack really lands inside Slack's 3-second window under real latency.

This runbook clears all four in one sitting. Steps 1–4 answer questions 1, 2 and 4; step 6 answers question 3.

## Before you start

| | Check | Why it bites |
| --- | --- | --- |
| 1 | `FORGE_MESSAGING_PROVIDER=slack` and the five `SLACK_*` keys are filled in | An empty `SLACK_BOT_USER_ID` is as good as switching the bot off: a channel message cannot be checked for a mention, so the core ignores every one |
| 2 | The console switches from [deploy/README.md](../deploy/README.md) §2.5 are on — scopes (**including `im:history`**), Socket Mode, event subscriptions, **Interactivity**, and the bot `/invite`d into every watched channel | Without Interactivity the card renders and the button silently does nothing — Slack forms are modals |
| 3 | A document source will claim your message | Intake is content-addressed. On Slack there is usually no Feishu doc link, so unless `doc_sources.plaintext.enabled: true` is set in `config/runtime.yaml` **every message is dropped** with a single `no document source claimed this message` warning — a warn, so the only symptom is "the bot ignored me" |
| 4 | The target project resolves and its repos are cloned and clean | Gate A reads real code; an unanchored checkout (HEAD off `origin/<branch>`, or uncommitted changes) is disclosed to the model or parks the gate |
| 5 | You accept that this spends money | Gate A is a real paid model call per requirement. With `plaintext` on, **every** long enough @-mention becomes one |

`FORGE_MESSAGING_PROVIDER=slack ./forge doctor` checks 1 and 4 and nothing else — 2, 3 and 5 are yours.

## The run

Keep `tail -f logs/launchd.log` (or the foreground `./forge listen`) visible throughout: three of the four
answers show up in the log rather than in Slack.

1. **`FORGE_MESSAGING_PROVIDER=slack ./forge doctor`** → every Slack row green. Two rows may stay red on a
   Slack-only host without meaning anything is wrong: `feishu-doc.js` (only ever used if a Feishu document
   link arrives) and `codex` (absent, so the adversarial reviewer degrades to claude reviewing itself — less
   independent, still functional).
2. **`./forge contract-check`** → the `conversations.history` envelope probe passes. This is the first call
   that proves the token and the scopes are real. The Slack probe itself is free and read-only; the same
   command also probes claude and codex with one trivial **paid** call each.
3. **Start the daemon** (`./forge listen`, or `./deploy/install.sh` for the resident pair) and confirm the log
   says the Socket Mode connection is open.
4. **@-mention the bot in a watched channel** with a requirement (a paragraph, if `plaintext` is on; a
   recognised document link otherwise) → a session is created and a status card appears in the channel.
   *If nothing happens*, the log distinguishes the two causes: `no document source claimed this message`
   (precondition 3) versus no inbound event at all (precondition 2).
5. **Gate A card → press the form button** → a modal opens carrying the per-decision dropdowns → submit once.
   → **Question 1** is answered the moment the modal appears: Slack accepted the view. (Rejected instead? The
   log carries `Slack views.open failed: …`, and the structural gate re-runs itself to say which block.)
   → **Question 2** needs one deliberate look, because the two halves of the payload fail *separately*:
   `private_metadata` coming back is visible as the single log line `cardAction: <action> <slug> by=<actor>`
   with the right slug; `state.values` coming back is visible as **your answers actually being there**. Check
   the latter rather than assuming it — if the form content is lost, the re-review still runs, carrying the
   placeholder `(the PM submitted without writing a specific reply)` into `gate-a.prompt.txt` in that
   session's log directory. That placeholder in a run where you *did* fill the form is the exact shape of a
   half-arrived submission.
   → **Question 4** is answered by the same click: an ack that missed the window shows up as Slack
   redelivering the envelope, i.e. that one `cardAction:` line appearing twice.
6. **Restart the daemon while a form card is still on screen, then press that card's button.** The modal must
   open in its **degraded** free-text form — not a dead button — and its answer must still land on the right
   requirement. (The modal's contents live in the process that built them; this is the path that matters after
   any restart.)
7. **Leave it connected for over an hour.** → **Answers question 3**: the log shows planned `disconnect`
   (`refresh_requested`) → reconnect cycles, with no gap and no duplicate deliveries. The backfill on
   reconnect is what covers the gap, so check that nothing posted during a swap went missing **and** that
   nothing was processed twice.
8. **Optional, and the only step that writes outward**: a GO card → the DRI modal → issues really created.
   Not needed for the four questions — it exercises a second view, and it creates real issues in the target
   project.

## If a step fails

The blast radius was contained on purpose, and it has not moved: a wrong modal assumption is
[src/slack/modal.ts](../src/slack/modal.ts) plus the `decisionForm` / `goForm` cases in
[src/messaging/slack.ts](../src/messaging/slack.ts). Nothing in the core, nothing in the other provider.

- A card never appears, and the log carries `invalid_blocks` → the structural gate re-runs itself after Slack
  says no and turns it into "block 3's `section.text` is empty". Fix
  [src/slack/blockkit.ts](../src/slack/blockkit.ts)'s limits table, which is the single source of truth, and
  the corpus test will hold the fix.
- A button does nothing → Interactivity is off (precondition 2), or the `trigger_id` expired: it lives 3
  seconds, which is why `views.open` deliberately does **not** go through the rate-limit retry.
- The same click is handled twice → the ack missed the 3-second window (question 4, answered in the negative).

## Closing it out

Record what each step actually did — the four answers, not "it worked" — in
[#14](https://github.com/angelozhangai/forgeline/issues/14), and close it. If any answer comes back negative,
that is a new issue against the file named above, not a reopening of the seam work.
