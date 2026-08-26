---
name: deploy-forge
description: The canonical, source-of-truth installer for Forge on macOS. A strict step-by-step BLOCKING checklist — it halts at each prerequisite gate (Node, main repo, secrets in forge.env, claude/codex/gh logins, the IM developer console - Feishu or Slack) and guides the user through filling/installing it before advancing, then installs the launchd daemon + watchdog and verifies. Use whenever installing, deploying, redeploying, updating, or moving Forge to a Mac. macOS only.
---

# Deploy Forge — canonical step-by-step installer (macOS)

This skill is the **single source of truth** for installing Forge. Drive it as a **strict, ordered, BLOCKING checklist**: at each gate, run the check and report ✓/✗. On ✗, STOP — print the exact remediation, wait for the user to do it, then re-run the check. **Never skip a failing gate or advance past it.** **Never fill the user's secrets or run their OAuth/logins for them** — you guide, verify, and wait; they act.

macOS only (launchd). Push only when the user explicitly requests it and only under the repository rules in `CLAUDE.md`; ignored runtime assets and secrets are never pushed. These instructions are provider-agnostic: Claude Code or Codex can drive them.

## How to drive
Announce each gate → run its check → report ✓/✗. On ✗: give the precise command/edit, then **stop and wait** for the user to confirm done, then re-check. Only advance on ✓. The mechanical prep (gates 1–3, plus scaffolding for 4) is bundled in `./deploy/bootstrap.sh`; `./forge doctor` re-checks gates 1–6 at once and is your fastest re-verify after the user fixes something.

## Moving from an existing Mac

Before Gate 0, choose either development-only setup or full service takeover. For a full takeover, BLOCK until the old host's daemon and watchdog are stopped, required secrets/config are transferred outside Git, and any SQLite state comes from a verified backup. Never start the new production daemon while the old production daemon is still active.

---

### Gate 0 — Platform
Run `uname`. Not `Darwin` → STOP: Forge only deploys on macOS (launchd). Do not continue.

### Gate 1 — Node ≥ 24
`node -v`. Missing or major < 24 → if `brew` exists, offer `brew install node`; else point to https://nodejs.org. BLOCK until `node -p 'process.versions.node.split(".")[0]'` ≥ 24.

### Gate 2 — Target project + its code repos
Forge calls the target project's scripts (the live source of truth); the default target project is `example-project`. Check `$FORGE_PROJECT_ROOT` or sibling `../example-project/.git`.
- Missing → guide: `git clone git@github.com:your-org/example-project.git <sibling-of-this-repo>` (needs their SSH/gh access). BLOCK until present.
- Three code repos (demo / example-web / example-admin): `./forge doctor` shows each. Any "not cloned" → have them run the main repo's `./scripts/bootstrap.sh`. BLOCK until all three report a HEAD sha.

### Gate 3 — Dependencies
`npm install` (or `./deploy/bootstrap.sh`, which does gates 1–3 + scaffolds gate 4). Verify `node_modules/@larksuiteoapi/node-sdk` exists.

### Gate 4 — Secrets: `config/forge.env`  ⛔ BLOCKING · manual
If missing: `cp config/forge.env.example config/forge.env`. Then open it and walk the user through filling it **one block at a time — do NOT fill these for them**:
- `FORGE_PROJECT_ROOT` — blank = auto-find the sibling target project (fine if `example-project` is a sibling).
- **`FORGE_MESSAGING_PROVIDER` — settle this first**: empty = `feishu`, or `slack`. Anything else **stops the service from starting**, deliberately: a silent fallback would send every approval card to the old provider with no symptom at all. Then fill **only the chosen provider's block** — the other one is dead weight, and `forge doctor` only checks the provider in effect.

**If `feishu`:**
- Feishu bot: `FEISHU_BOT_APP_ID`, `FEISHU_BOT_APP_SECRET`, and a DM target (`FEISHU_DM_OPEN_ID` or `FEISHU_DM_UNION_ID`/`FEISHU_DM_CHAT_ID`/`FEISHU_DM_EMAIL`).
- `FEISHU_WATCH_CHATS` — the watch group's chat_id; and/or `FEISHU_REVIEW_WEBHOOK` for the result group card.
Tell them where each comes from (Feishu admin → the app's credentials; the group's chat_id). BLOCK until bot creds + a DM target are non-empty (the rest can follow).

**If `slack`:** (each key is documented inline in `config/forge.env.example`; all of them come from Gate 6's console work)
- `SLACK_BOT_TOKEN` (`xoxb-…`) and `SLACK_APP_TOKEN` (`xapp-…`, Socket Mode).
- `SLACK_BOT_USER_ID` — **leaving it empty is as good as switching the bot off**: a channel message cannot be checked for a mention of this bot, so the core conservatively ignores every one of them.
- `SLACK_DM_USER_ID` (where alerts and forms are pushed) and `SLACK_WATCH_CHANNELS` (the channel entry point plus the offline backfill).
- ⚠️ **Also settle the document source**, or the whole thing looks dead: intake is content-addressed, and on Slack there is usually no Feishu doc link to claim, so **every message is dropped with a single `no document source claimed this message` warning** — a warn, not an error, so the only symptom is "the bot ignored me". Turn on the fallback source in `config/runtime.yaml`:
  ```yaml
  doc_sources:
    plaintext:
      enabled: true
  ```
  State the cost plainly before they do it: once on, an @-mention carrying a long enough paragraph **is** a requirement and runs Gate A — a paid model call, per message.
BLOCK until the bot token, the app token and `SLACK_BOT_USER_ID` are non-empty.

If the user explicitly wants degraded mode (no IM at all — desktop+log only), note it and let them proceed, but say plainly what they lose (no channel intake, no buttons, no DM alerts).

### Gate 5 — CLI logins  ⛔ BLOCKING · manual
Each must be **installed AND authenticated**. Check and block individually:
- **gh**: `gh auth status` → not logged in → `gh auth login` (needs your-org org access — the write scripts create issues).
- **claude**: the service runs `claude -p`; confirm it's logged in. Unattended Mac mini → `claude setup-token` and put the token in `CLAUDE_CODE_OAUTH_TOKEN` in `forge.env`.
- **codex**: confirm `codex` is authenticated (it's the adversarial reviewer).
Re-verify with `./forge doctor` (it reports each CLI + gh login). BLOCK until all three are ✓.

### Gate 6 — the IM developer console  ⛔ BLOCKING · manual · only the user can do this
Take the branch matching the `FORGE_MESSAGING_PROVIDER` settled in Gate 4. You cannot fully auto-verify either one — `./forge doctor` proves the keys are present and well-formed, never that the console switches are on.

**Feishu** (full checklist in `deploy/README.md` §3), the user must:
1. Event & callback → subscription method → **long connection**.
2. Subscribe events: `im.message.receive_v1` + card callback (`card.action.trigger`).
3. Permissions: `im:message.group_at_msg:readonly` + `im:message:send` (+ offline backfill: `im:message.history:readonly`, `im:message.group_msg`), then **publish a new version** (may need admin approval).
4. **Add the bot to the watch group.**
Smoke-test what you can: `./forge doctor` should show the bot direct-message check passing. BLOCK on the user confirming the 4 backend steps (or explicitly accepting degraded mode).

**Slack** (full checklist in `deploy/README.md` §2.5) — at api.slack.com/apps → create an App, the user must:
1. **OAuth & Permissions → Bot Token Scopes**: `chat:write`, `channels:history`, `groups:history`, `im:history`, `im:write`, `users:read`, then install it into the workspace → the `xoxb-…` token. **`im:history` is the one that gets missed**, and missing it means a requirement sent by direct message cannot be read back during the offline backfill — gone, with no error anywhere.
2. **Socket Mode → on**, and under Basic Information → App-Level Tokens a token with `connections:write` → the `xapp-…` token.
3. **Event Subscriptions → subscribe** to `message.channels` / `message.groups` / `message.im`.
4. **Interactivity & Shortcuts → on**. **Required, not optional**: Slack's input elements are invalid inside a message, so every Forge form is a modal — without this the card renders and the button does nothing.
5. **`/invite` the bot** into each channel in `SLACK_WATCH_CHANNELS`.
Smoke-test what you can: `FORGE_MESSAGING_PROVIDER=slack ./forge doctor` (every Slack row green) then `./forge contract-check` (the `conversations.history` envelope probe). BLOCK on the user confirming steps 1–5.

Four things about Slack's own behaviour still cannot be proved by any of the above — that a real `views.open` accepts the view, that one `view_submission` returns `private_metadata` plus all of `state.values`, that the planned `disconnect` really arrives about every half hour, and that an ack lands inside the 3-second window under real latency. They are cleared once, by hand, on the first workspace: after Gate 9, run the runbook in `docs/slack-golive.md`.

### Gate 6b — Downstream (gate C / gate D) prerequisites  ⛔ conditional · only if this host runs implement→PR
Upstream (PRD→issue) needs none of this — skip if this host is upstream-only. But if this host will run **gate C (implement + local CI)** or **gate D (PR adversarial review)**, two things must hold for the *target project's checkout* before you uncomment its `scripts:` block in `config/projects.yaml` / `runtime.yaml`:

1. **The target repo's `origin` must be fetchable non-interactively.** Every tick forge anchors the checkout with `git fetch origin <branch>`; if the host's SSH to the git host is blocked (e.g. a zero-trust proxy), it fails silently each tick and downstream never advances.
   - `git -C <target-repo> remote -v` — if `origin` is `git@…` and SSH is blocked, switch to HTTPS: `git -C <target-repo> remote set-url origin https://github.com/<org>/<repo>.git`.
   - Give unattended fetch credentials via a `gh`-backed helper: `git -C <target-repo> config credential.helper '!f() { echo username=<gh-user>; echo "password=$(gh auth token)"; }; f'`.
   - Verify: `git -C <target-repo> fetch origin <branch>` exits 0 with no prompt.
2. **The host must be a real build env for that project.** Gate C and gate D build an isolated worktree (via the project's `tools/scripts/wt.sh`) and run the project's CI inside it — needs the project's full toolchain + secrets present (e.g. your-monorepo: `pnpm`, `direnv`/`.envrc`, `.secure-config`, a working `pnpm install`/`node_modules`). Confirm `tools/scripts/wt.sh <sibling-path> -b throwaway origin/<base>` succeeds end-to-end (worktree created, deps resolve, the project's CI script runs), then `git worktree remove` it. Without this, every gate C tick fails at worktree/CI setup.

BLOCK (for downstream use) until both verify. If either can't be met, leave the `scripts:` block commented — forge stays upstream-only and healthy.

Once both verify, the first real-host end-to-end downstream smoke follows the runbook at `docs/downstream-validation.md`.

### Gate 7 — Preflight green
Run `./deploy/bootstrap.sh` (no `--install`). It must reach **"preflight all green -- ready to deploy"** (exit 0). Any `forge doctor` ✗ → return to the matching gate above. Do not install until green (unless the user explicitly accepts degraded mode and runs `./deploy/install.sh` directly).

### Gate 8 — Install
⚠️ Warn first: a running daemon auto-runs gates and the daily contract probe — **it starts spending money automatically.** On the user's OK, run `./deploy/bootstrap.sh --install` (installs + starts the launchd daemon + watchdog).

### Gate 9 — Verify & report
- `./forge health` → total status healthy.
- `curl -s http://127.0.0.1:4319/health` → daemon up, with the external-CLI contract check present.
- Report: deployed; status page `http://127.0.0.1:4319/`; logs `tail -f logs/launchd.log` / `logs/watchdog.log`; uninstall `./deploy/uninstall.sh` (keeps `state/` + `logs/`).

---

## Redeploy / update (already-installed machine)
Code changed → restart to load it: `launchctl kickstart -k gui/$(id -u)/com.forge.daemon` (the watchdog self-heals it too). Then re-run gates 7–9 to confirm.

## Rules
- Strict gate order; never skip a failing gate.
- Push only when explicitly requested; never push ignored runtime assets or secrets.
- Never fill secrets or run the user's OAuth/logins.
- Idempotent — safe to re-run at any gate.
