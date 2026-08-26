# deploy — the resident Forge daemon (launchd), the watchdog, the IM long connection (Feishu / Slack), and the local status page

> **Forge** is this service's name: it forges a PRD into a technical plan and issues. The launchd labels are `com.forge.daemon` and `com.forge.watchdog`, and the launchers are `deploy/forge-daemon` and `deploy/forge-watchdog`.
>
> Under macOS's System Settings → Login Items & Extensions → Background App Activity you will see **forge-daemon / forge-watchdog · unidentified developer** (the scripts carry no Developer ID signature, which is expected) — **leave the toggle on**. Turning it off stops launchd from starting them, so the service no longer runs at login or stays resident. Do **not** add anything to "Open at Login" by hand: a LaunchAgent starts itself through `RunAtLoad` and does not use that list.

The service has grown from a manual `forge tick` into a **resident daemon**: an IM long connection receiving card buttons and channel messages, a built-in periodic tick, and a direct message to you whenever something breaks or needs you.

## 1. The daemon: `forge listen`

One resident process doing three things:

1. **The IM long connection**: it receives **card button callbacks** (confirm, produce the plan, go, deny, retry) and **channel message events**, including a PRD link, which it turns into an `addPrd` automatically.
2. **The built-in periodic tick**, every `runtime.yaml: poll_interval_sec` seconds: it advances gates A and B and heals orphaned sessions. It runs even when the long connection never came up.
3. **Notifications it starts itself**: awaiting confirmation, awaiting go, a failure, a completion or a recovery all become an interactive card in your direct messages.

> With `FEISHU_BOT_APP_*` unset it degrades automatically: the periodic tick still runs, there is no long connection (so the buttons and the channel entry point are unavailable), and notifications go to the desktop and the log.

## 2. Installing it in one step (the daemon, the watchdog and the status page)

It runs as a **LaunchAgent**, not a daemon: at the user level, so the login keychain is present and the claude, codex and gh credentials work. It does not run while logged out or shut down.

Two jobs: the **daemon** (`KeepAlive`, keeping `forge listen` resident) and the **watchdog** (`StartInterval`, running `forge watchdog` every 60s to rescue a wedged process).

> **🧭 The source of truth for installing is the `/deploy-forge` skill** (deploying to a brand-new Mac from scratch). Have Claude Code or Codex run **`/deploy-forge`**: it is a step-by-step **blocking** install guide. Every prerequisite — node ≥ 24, the main repo, the secrets in `forge.env`, being logged in to `claude`, `codex` and `gh`, and the IM developer console covered in section 3 — **stops at its own gate**, walks you through filling it in, verifies it, and only then lets you through, before finally installing the launchd jobs and verifying the result. It **never enters a secret for you**.
>
> **Moving to another machine, or retiring the old host**: stop the old machine's daemon and watchdog first, move the secrets and the `state/` SQLite database across outside Git if you need them, and then install strictly from Gate 0. Never let two independent SQLite databases consume the same production entry point at once.
>
> The mechanical part is handled by **`./deploy/bootstrap.sh`** (checking node, checking the main repo, `npm install`, scaffolding the config, the git hooks, and the `forge doctor` preflight). To run it yourself, `./deploy/bootstrap.sh` prepares and preflights without spending anything; once the preflight is green, `--install` installs in one step. On a machine already deployed to, go straight to `install.sh` below.

```bash
./deploy/bootstrap.sh      # a new machine: prepare and preflight (spends nothing); --install installs once the preflight is green
./deploy/install.sh        # idempotent: render the plists (substituting the path placeholder) -> bootstrap -> enable; safe to run again
launchctl list | grep forge
tail -f logs/launchd.log   # the daemon's log
tail -f logs/watchdog.log  # the watchdog's log
open http://127.0.0.1:4319/   # the local status page
```

Stopping and uninstalling:

```bash
./deploy/uninstall.sh      # stop and uninstall both jobs; state/ and logs/ are kept
```

> The plists are **templates** carrying a `__SVC__` placeholder that `install.sh` replaces with the current repo root before installing. A new machine or a moved directory just means running `install.sh` again -- there is no hardcoded path to edit. Do not `cp` a template yourself.
>
> ⚠️ **Automatic means spending money automatically**: post a PRD link in a channel and the next tick runs gate A (about $1-2). The expensive gate B still waits for you to press "produce the technical plan", so it cannot run away with itself.

### Two layers of keeping it alive: KeepAlive rescues a dead process, the watchdog rescues a wedged one

- **The daemon plist**: `KeepAlive=true` restarts the process whenever it exits, and `ThrottleInterval=30` keeps a crash loop from becoming a restart storm.
- **But `KeepAlive` cannot rescue a process that is alive and wedged** — when the long connection has dropped, the event loop is blocked, or the tick lock is stuck, the process is still there and launchd does nothing.
- **The watchdog** (a separate process, every 60s) probes `/healthz`, reads the `liveness` heartbeat and checks `launchctl` status, then decides:
  - The process is not running → `launchctl kickstart` to start it, plus an alert.
  - The process is running but **wedged** (liveness has expired and the probe has failed the threshold number of times in a row):
    - **with a gate still running** → alert that the kill is being held off, and only `kickstart -k` if it is still wedged after the grace window (`wedged_grace_sec`, 300s). This is what **stops an in-flight claude or codex call being interrupted and its tokens wasted**. Orphans are reclaimed automatically after the restart.
    - with no gate running → `kickstart -k` immediately, plus an alert.
  - Recovered → a "recovered" alert. It is **debounced**: alerts fire when the state flips, not every minute.
  - It also rotates `logs/launchd.log` in passing, once it exceeds `health.log_rotate_mb` (20MB).

Every parameter lives in `config/runtime.yaml › health`, and the port can be overridden by `FORGE_HEALTH_PORT`. To check by hand: `./forge health`, or `--json` for structured output.

## 2.5 Switching to Slack (optional)

The transport is a seam (`MessagingPort`) with Feishu and Slack as two implementations of it, and **not one line of the core changes**. Set `FORGE_MESSAGING_PROVIDER=slack` in `config/forge.env` and fill in the handful of `SLACK_*` values (each key and what it means is documented inline in `config/forge.env.example`). No new dependencies: the Web API goes through the native `fetch`, and Socket Mode through Node's built-in `WebSocket`.

> ⚠️ **A misspelled provider name stops the service from starting**, deliberately. Falling back to Feishu silently would mean you believe you are on Slack while every approval card still goes to Feishu and Slack stays empty — **with no symptom at all**. Better that it refuses to start.

What to switch on in the Slack console (api.slack.com/apps → create an App):

1. **OAuth & Permissions → Bot Token Scopes**: `chat:write`, `channels:history`, `groups:history`, `im:history`, `im:write`, `users:read`. Install it into the workspace and you get an `xoxb-…` token → `SLACK_BOT_TOKEN`.
   **Do not miss `im:history`**: subscribing to `message.im` without granting it means a requirement sent by direct message cannot be read back during the offline backfill — it is simply gone, with no error anywhere. (`config/forge.env.example` carries the same list; the two have to agree.)
2. **Socket Mode → on**; under **Basic Information → App-Level Tokens** create a token with `connections:write` (an `xapp-…`) → `SLACK_APP_TOKEN`.
3. **Event Subscriptions → subscribe** to `message.channels` / `message.groups` / `message.im`.
4. **Interactivity & Shortcuts → on**. This one is **required**: Slack's input elements are not valid inside a message, so a review form can only be a modal, and without it pressing the button does nothing.
5. `/invite` the bot into the channels you want watched and put their ids in `SLACK_WATCH_CHANNELS`; put the bot's own user id in `SLACK_BOT_USER_ID` (**leaving it empty is as good as switching the bot off**: it cannot tell whether a channel message mentioned it, so it conservatively ignores every one).

Running `FORGE_MESSAGING_PROVIDER=slack ./forge doctor` checks each of those in turn.

> **The first workspace also needs one manual pass.** doctor proves the keys are present, never that Slack itself behaves as documented — that a real `views.open` accepts the view, that one `view_submission` returns `private_metadata` plus all of `state.values`, that the planned `disconnect` arrives about every half hour, and that an ack lands inside the 3-second window. The runbook that clears all four in one sitting is [docs/slack-golive.md](../docs/slack-golive.md).

**It feels the same as Feishu**: the review and filing forms are answered on the card itself — pick the options, press submit once. (Interactivity, point 4 above, is still required: it is what delivers the button press.) Cards posted before forms moved into the card still open a plain free-text modal when clicked, because their questions were never written into the message.

### Where the requirement document comes from

Reading the requirement document is a separate seam of its own (`DocSourcePort`) — a registry rather than a selection point, because one message may carry links from several sources at once. Two are registered by default:

- **Feishu documents** — it recognises `wiki`, `docx` and `docs` links, and can write the review comments back;
- **plaintext (the fallback, off by default)** — it treats "@bot plus a paragraph" as the requirement body itself, needing no document service. Switch it on with `doc_sources.plaintext.enabled: true` in `config/runtime.yaml`.
  ⚠️ Once it is on, a message like that **really does file a requirement and run gate A, which spends money automatically**; today such messages are simply ignored. Anything below the substance threshold once normalised (a "thanks, got it") is not treated as a requirement.

If you are on Slack with no document service to hand, switching plaintext on is enough to run the whole chain.

---

## 3. ⚠️ What to switch on in the Feishu developer console (only you can do this, and the long connection depends on it)

> On Slack, skip this section and read 2.5 above.

Create an internal app in the Feishu developer console (and put its App ID and secret into `config/forge.env`), switch the following on, and then **publish a new version** — an internal app needs an administrator to approve it before it takes effect:

1. **Events & callbacks → subscription method → choose "receive events and callbacks over a long connection"** (not a webhook URL).
2. **Subscribe to the events**:
   - `im.message.receive_v1` (receiving messages, which is the channel entry point)
   - the card callback (`card.action.trigger`, for interactive card buttons) — tick it under the console's card-callback section.
3. **Permissions** (permission management → grant → publish):
   - The basics, receiving messages that @-mention the bot and posting cards: `im:message.group_at_msg:readonly` plus the `im:message:send` you already have. At this level **product has to @-mention the bot** for anything to happen.
   - **Letting product skip the mention** (pasting a link is enough, which feels better): additionally grant `im:message.group_msg`, which receives channel messages that do **not** mention the bot.
     The code is already ready for it — the adapter sets `policy.requireMention:false` (`src/messaging/feishu.ts`), and `handleMessage` only looks for a document link rather than requiring a mention. **This scope is the only prerequisite**: without it the server never pushes an un-mentioned message at all.
   - **Offline backfill** additionally needs `im:message.history:readonly`, to read channel history and recover messages missed while disconnected or asleep.
   - Backfill also uses `im:chat:readonly` to ask once whether a chat is a group or a direct message. It only asks when a history entry does not carry `chat_type` itself, and it remembers the answer per chat, so one process asks once. **It runs without this permission**, but when it cannot tell it treats every chat as a group — so **a requirement sent by direct message while offline is dropped by the "nobody mentioned me in the channel" intake gate**. If you only ever use the channel entry point this does not matter; if people may send requirements by direct message, grant it.
   - The channel entry point also needs the **bot added to that channel**.
4. **The direct-message target** is already wired up (`union_id`, see `config/forge.env`), and the watched chats go in `FEISHU_WATCH_CHATS`.

Without steps 1 and 2, `forge listen` still runs (the periodic tick and direct-message notifications), but **pressing a button does nothing and channel messages never arrive**. Switching them on takes effect immediately — the daemon starts receiving the callbacks on its own.

## 4. Notification channels and configuration

`src/notify.ts` is the single outbound point: **a bot direct-message card (schema 2.0, with buttons), falling back to the webhook**; **the desktop and the log are always the final fallback**.

- The bot: `FEISHU_BOT_APP_ID` / `SECRET` plus `FEISHU_DM_UNION_ID` in `config/forge.env` (already configured).
- To turn desktop notifications off: `NOTIFY_DESKTOP=0`.

## 5. The whole flow, driven from cards (once the buttons are wired up)

```
a PRD link posted in a channel -> addPrd automatically -> gate A -> a "🔴 awaiting confirmation" direct message
  └ choose a verdict, add notes, submit -> confirm -> a "✅ confirmed" card, carrying a "🛠 produce the technical plan" button
      └ press it -> gate B plus the adversarial review -> a "🟡 awaiting the go-ahead" card, with "✅ go / ❌ deny"
          └ press go -> the issues are created -> a "✅ filed" card, with the links
any step failing -> a "❌ failed" card, carrying "🔁 retry"
```

The whole thing happens by pressing buttons in a direct message, without touching a terminal.

> Cards speak **plain language**: each card's header is the **requirement number `REQ-n` and its title**, and the state reads as "reviewing the requirement", "waiting on product to confirm", "waiting for the technical plan", "waiting on the go-ahead" and so on. The gate A / gate B jargon stays inside the code. The number is assigned the moment a requirement arrives, follows it all the way through, and is written into the body of the GitHub issues it creates.

## 6. Reliability: staying awake, automatic backups, and offline backfill

Three safeguards make "running on the laptop I carry around" something people can actually rely on. All three are built in and need nothing from you:

1. **Staying awake**: `forge-daemon` wraps the daemon in `caffeinate -is`, so while the Mac is awake — at the office, or at home with the lid open — it neither idles nor system-sleeps, and the long connection holds.
   > Closing the lid and putting it in a bag still sleeps it; that is a system-level behaviour and cannot be changed without sudo. On waking, **offline backfill** recovers the channel messages from that window, so no requirement is lost.
2. **Automatic backups**: every hour the daemon takes an online backup of `state/service.db` into `state/backups/` (using `node:sqlite`'s native backup, which is safe with the connection open), keeping the most recent 14. It also takes one immediately at startup.
   - **To restore** (after corruption, or an accidental delete):
     ```bash
     launchctl bootout gui/$(id -u)/com.forge.daemon        # stop the daemon first
     cp state/backups/service-<most recent timestamp>.db state/service.db    # overwrite with the most recent backup
     launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.forge.daemon.plist
     ```
3. **Offline backfill**: while the machine is shut down or asleep, the long connection does not redeliver the events it missed. So at startup, on every reconnect, and on every cycle, the daemon pulls channel history through `im.v1.message.list` and registers the PRDs it missed, using the `chat_cursor` watermark. The cursor only moves forward and entries are deduplicated by URL, so nothing is missed and nothing is registered twice. It needs the `im:message.group_msg` permission (see section 3).

## 7. The local status page (in the spirit of status.claude.ai)

The daemon embeds a health service bound to **`127.0.0.1` only** (with no external dependencies, and it answers even while a gate is running — claude and codex are spawned asynchronously and never block the event loop).

| Route | What it is for |
| --- | --- |
| `GET /` | The status page HTML: an overall banner, a health light per component, a bar of uptime over the last 72h, and the PRD pipeline board, highlighting anything stuck in `AWAITING_*` or `*_FAILED` |
| `GET /healthz` | A minimal `200 ok` (the watchdog's cheap probe) |
| `GET /health` | Live health as JSON (the daemon, the long connection, the database, backups, dependencies, disk, and parked work) |
| `GET /api/board` | The board's data (grouped by state, plus the sessions needing attention) |
| `GET /api/history` | The rolling history (uptime plus a timeline of outages and recoveries; `?hours=72`) |

The health grades are `healthy` (everything green), `degraded` (the long connection is down, a dependency is missing, backups have stalled, disk is tight, or something is `*_FAILED`), and `down` (the heartbeat is missing or the process is wedged, the database will not open, or the disk is full). Every 60s the daemon writes one `health_sample` row to SQLite, pruned according to `history_retain_hours`, and the status page draws its uptime from those. When the **overall state flips**, the daemon sends the alert itself — except for a process-level outage or a wedge, where the watchdog sends it, because by then the daemon cannot.

Open it with `open http://127.0.0.1:4319/`.

## 8. Deploying to an unattended Mac mini

1. **Log in automatically**: System Settings → Users & Groups → log in automatically as your account. A LaunchAgent needs a logged-in session's keychain for the claude, codex and gh credentials, so do not use a LaunchDaemon.
2. **Stop it sleeping**: `forge-daemon` already uses `caffeinate -is`; add `sudo pmset -a sleep 0 disablesleep 1` at the system level too (a Mac mini is usually on mains power and can stay awake indefinitely).
3. **Install the service**: `./deploy/install.sh` installs the daemon, the watchdog and the git hook in one go.
4. **Reading the status page remotely**: do not expose the port. Use an SSH tunnel and read it locally:
   ```bash
   ssh -L 4319:127.0.0.1:4319 mini   # then open http://127.0.0.1:4319/ in your own browser
   ```
5. **The alerting path**: check that `FEISHU_BOT_APP_*` and `FEISHU_DM_*` are set in `config/forge.env` — an outage, a wedge and a recovery are all pushed to your direct messages.
6. **Logs**: the watchdog rotates `launchd.log` by size. To hand the job to the system instead, see `deploy/newsyslog/` (optional, and it needs sudo).
