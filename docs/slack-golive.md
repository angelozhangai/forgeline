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

None of that can prove what Slack's own servers do. **Two questions are left, and only a real workspace
answers them:**

1. the planned `disconnect` (`refresh_requested`) really arrives about every half hour;
2. an ack really lands inside Slack's 3-second window under real latency.

There used to be four. The other two — *does a real `views.open` accept this view*, and *does one
`view_submission` return `private_metadata` plus all of `state.values`* — were **answered by deleting the
modal**, not by testing it. Forms are now rendered into the card (input blocks are legal in a message, and
the message's whole `state` rides along with any button press from it), so there is no view to open and no
`private_metadata` to survive a round trip. That change was made *because* a real workspace was finally
available: the card as it stood printed its options as text that looked clickable and was not.

This runbook clears both in one sitting: steps 1–5 get you to a live card and a submitted form, **step 5
answers question 2** (a missed ack is observable only as the same callback arriving twice), and **step 7
answers question 1** — the one that just needs an hour of wall clock.

## Before you start

| | Check | Why it bites |
| --- | --- | --- |
| 1 | `FORGE_MESSAGING_PROVIDER=slack` and the five `SLACK_*` keys are filled in | An empty `SLACK_BOT_USER_ID` is as good as switching the bot off: a channel message cannot be checked for a mention, so the core ignores every one |
| 2 | The console switches from [deploy/README.md](../deploy/README.md) §2.5 are on — scopes (**including `im:history`**), Socket Mode, event subscriptions, **Interactivity**, and the bot `/invite`d into every watched channel | Without Interactivity the card renders and the button silently does nothing — it is what delivers the press |
| 3 | A document source will claim your message | Intake is content-addressed. On Slack there is usually no Feishu doc link, so unless `doc_sources.plaintext.enabled: true` is set in `config/runtime.yaml` **every message is dropped** with a single `no document source claimed this message` warning — a warn, so the only symptom is "the bot ignored me" |
| 4 | The target project resolves and its repos are cloned and clean | Gate A reads real code; an unanchored checkout (HEAD off `origin/<branch>`, or uncommitted changes) is disclosed to the model or parks the gate |
| 5 | You accept that this spends money | Gate A is a real paid model call per requirement. With `plaintext` on, **every** long enough @-mention becomes one — and in a **DM there is no mention gate at all**, so every long enough message you send the bot is a requirement. Thinking out loud to it is not free |

`FORGE_MESSAGING_PROVIDER=slack ./forge doctor` checks 1 and 4 and nothing else — 2, 3 and 5 are yours.

## Rehearse first — it is free

`forge rehearse` sends **every card Forge can produce** (one per `NotifyKind`, one per `State`, including the
two that carry a form) to the chat you configured, and `--listen` then prints every button callback verbatim.
No model call, no session in the database, no issue, no document — the only outward effect is messages in
that chat.

```bash
./forge rehearse --listen        # --only dm / --only channel to narrow it
```

It answers three of the four questions on its own — a real `views.open` accepted the view, one
`view_submission` returned the context plus every field, and a redelivered callback (the only way to observe
a missed ack from outside) is named as one. What it deliberately does **not** touch is the gates and the
state machine: nothing is registered, so nothing advances. Do this before spending anything; if a card is
rejected here, the paid run below would only have found the same thing later and more expensively.

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
3. **Start the daemon** (`./forge listen`, or `./deploy/install.sh` for the resident pair). Confirm the Socket
   Mode connection is actually up with `./forge health --json` → `ws.connected: true` (the status page shows
   the same thing). Do not take "no error in the log" for a connection: with the bot credentials missing the
   daemon degrades on purpose to the periodic tick with no connection at all, and says so once.
4. **@-mention the bot in a watched channel** with a requirement (a paragraph, if `plaintext` is on; a
   recognised document link otherwise) → a session is created and a status card appears in the channel.
   *If nothing happens*, the log distinguishes the two causes: `no document source claimed this message`
   (precondition 3) versus no inbound event at all (precondition 2).
5. **Gate A card → answer it on the card** — the options are radio buttons, right there in the message —
   **then press submit once.**
   → Check that your answers **actually arrived**, rather than assuming they did: if the form content is
   lost, the re-review still runs, carrying the placeholder `(the PM submitted without writing a specific
   reply)` into `gate-a.prompt.txt` in that session's log directory. That placeholder in a run where you
   *did* fill the form is the exact shape of a half-arrived submission.
   → **Question 2** is answered by the same click: an ack that missed the window shows up as Slack
   redelivering the envelope, i.e. one `cardAction: <action> <slug> by=<actor>` line appearing twice.
   → Picking an option also sends a callback of its own — that is normal, and the adapter ignores everything
   that is not the button. What must **not** happen is the session advancing before you press submit.
6. **Restart the daemon while a form card is still on screen, then answer that card.** It must still work,
   unchanged — the form is in the message, so a restart takes nothing with it. (This step used to be the
   interesting one: the modal's contents lived in the process that built them, so a restart degraded the card
   to a free-text box. That failure mode is gone; the step stays to prove it.)
7. **Leave it connected for over an hour.** → **Answers question 1**: the log shows planned `disconnect`
   (`refresh_requested`) → reconnect cycles, with no gap and no duplicate deliveries. The backfill on
   reconnect is what covers the gap, so check that nothing posted during a swap went missing **and** that
   nothing was processed twice.
8. **Optional, and the only step that writes outward**: a GO card → pick a DRI → issues really created.
   Not needed for either question — it exercises a second form, and it creates real issues in the target
   project.

## If a step fails

The blast radius was contained on purpose, and it has not moved: a wrong modal assumption is
[src/slack/modal.ts](../src/slack/modal.ts) plus the `decisionForm` / `goForm` cases in
[src/messaging/slack.ts](../src/messaging/slack.ts). Nothing in the core, nothing in the other provider.

- A card never appears, and the log carries `invalid_blocks` → the structural gate re-runs itself after Slack
  says no and turns it into "block 3's `section.text` is empty". Fix
  [src/slack/blockkit.ts](../src/slack/blockkit.ts)'s limits table, which is the single source of truth, and
  the corpus test will hold the fix.
- A button does nothing → Interactivity is off (precondition 2). Nothing on this path expires any more: the
  three-second `trigger_id` only ever mattered for opening a modal.
- The same click is handled twice → the ack missed the 3-second window (question 2, answered in the negative).

## Closing it out

Record what each step actually did — the two answers, not "it worked" — in
[#14](https://github.com/angelozhangai/forgeline/issues/14), and close it. If any answer comes back negative,
that is a new issue against the file named above, not a reopening of the seam work.
