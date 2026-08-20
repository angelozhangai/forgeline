# Forgeline — governed AI delivery, on rails

[![CI](https://github.com/angelozhangai/forgeline/actions/workflows/ci.yml/badge.svg)](https://github.com/angelozhangai/forgeline/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**PRD review → tech design → implementation → PR → merge-ready, with AI doing the work and humans holding every trigger.**

Forgeline automates the requirements-to-delivery chain most AI dev tools skip: it starts **before a single line of code**, reviewing the PRD itself against the live codebase. It writes no code of its own — instead it orchestrates two heterogeneous coding agents (**Claude Code** and **Codex**, via their CLIs) to adversarially cross-review each other, wraps them in **deterministic gates** (CI must be green, coverage floors, acceptance contracts), and keeps humans as first-class stops in the loop. **It never auto-merges. Ever.**

> Naming: **Forgeline** is the project; the service and CLI inside are called **`forge`** — short on purpose, like `kubectl` is to Kubernetes. Docs refer to the engine as Forge.

> Why this shape — the case for *not* building an agent harness, for dual-model adversarial review, and for deterministic gates — is argued in [docs/RATIONALE.md](docs/RATIONALE.md). A full feature/maturity map lives in [docs/OVERVIEW.md](docs/OVERVIEW.md).

## The trust model

Three failure classes, three mechanisms:

1. **Heterogeneous adversarial review** (Codex reviews ⇄ Claude revises, both resuming their own sessions) — catches *plausible-but-wrong reasoning*: one model's blind spot is rarely the other's.
2. **Deterministic gates** (local CI green, outer-loop acceptance contracts, type checks, zero blockers — never skippable, never AI-judged) — catches *"both agents agree, reality disagrees"*.
3. **Drift reconciliation + golden evals** — after issues ship, Forge audits merged code against the acceptance contracts it created (*approved ≠ delivered*); offline golden evals with an LLM judge guard the prompt assets against silent regression as the underlying models change.

Every hard stop is a human: answering open questions round by round (PM), arbitrating stalls (lead), triggering the design gate (permission-gated), the one-click **GO** that creates issues (permission-gated), and the final merge (always manual).

## Pipeline

```
PM posts PRD ─▶ Gate A  review the requirement against the live codebase
              │         (multi-round PM Q&A · then Codex adversarial re-review)
              ▼
          CONFIRMED ─▶ Gate B  tech design + outer-loop acceptance contracts + issue drafts
              │                (Codex reviews ⇄ Claude revises, needs_human escalation)
              ▼
         AWAITING_GO ─▶ human GO ─▶ issues created (DONE)
              ▼
            Gate C  implement in isolated worktrees ⇄ local CI until green
              ▼
            Gate D  open PR (never auto-merge) · Codex reviews diff ⇄ Claude fixes
              │     · anti-mirror test hardening · merge-readiness report
              ▼
     AWAITING_HUMAN_MERGE ─▶ human merges ─▶ SHIPPED ─▶ drift reconciliation
```

Any gate can **park** (`*_STALLED` / `*_FAILED`) instead of guessing: unresolved after N rounds, unparseable output, stale checkouts, permission misses — everything lands in an explicit state with the raw output persisted, waiting for a human. Failures are never silent.

## What's inside

- **Durable state machine** over SQLite (`node:sqlite`, zero native deps) — sessions span days, survive restarts, and resume mid-gate; orphaned runs are reclaimed with poison-pill limits so a crashing session can't burn tokens forever.
- **Transient vs permanent failure discipline** — timeouts/429s retry with backoff into a dead-letter parking lot; contract/permission errors stop immediately.
- **PRD-level idempotency** — one document = one requirement, enforced by token normalization plus a partial unique index; concurrent duplicates collapse into one.
- **Code-anchored review** — every gate fetches the target repos, pins ref+sha in the prompt, and verifies the working checkout actually sits on that sha (`anchorCheck`); drift is disclosed to the model or blocks the gate. No confident conclusions about stale code.
- **Session-resume token economics** — multi-round loops resume the same Claude/Codex sessions (`--resume` / `codex exec resume`), resending only deltas.
- **A reusable review⇄fix engine** ([src/review/reviewFixLoop.ts](src/review/reviewFixLoop.ts)) — the "reviewer judges → fixer revises → human escalation → round caps" loop is one generic engine, reused by Gates A, B, and D.
- **Messaging as a thin port** — the core depends on a provider-agnostic `MessagingPort` + semantic `CardModel`; Feishu (Lark) is the bundled adapter (long-connection daemon, interactive cards, offline backfill). A Slack adapter is one file away, with the core untouched.
- **Ops for a real service** — launchd daemon + watchdog (distinguishes *dead* from *wedged*, grace-periods active gates before force-restart), hourly SQLite backups, a localhost status page + web action panel that reuses the same permission gates as the CLI and cards.
- **Progressive autonomy** (default 0 = fully manual) — levels that auto-advance only *authorization-only* stops, with red lines no level can cross: never auto-merge, never skip a red CI, never answer a human-escalation on a human's behalf.
- **Multi-project / multi-tenant** — per-project permissions, routing, assignment pools, and prompt variants; one daemon serves them all.
- **Cost visibility** — per-session and cross-requirement cost aggregation across all four gates (`forge cost`, `forge show`).

## Quick start

Requires Node ≥ 24, plus logged-in `claude` and `codex` CLIs (Codex optional — the adversarial reviewer degrades per `runtime.yaml`).

```bash
npm install
cp config/forge.env.example config/forge.env   # point FORGE_PROJECT_ROOT at your target project
./forge doctor                                  # environment self-check

# Manual flow (no messaging platform needed):
./forge add --prd <doc-url>       # register a PRD
./forge tick                      # run Gate A → open questions, parked awaiting PM
./forge answer <slug> --notes "…" # answer round by round
./forge tick                      # re-review (same session) → adversarial pass → CONFIRMED
./forge gateb <slug> --user M     # tech design + adversarial loop (permission-gated)
./forge go <slug> --user M --dry-run   # preview what would be created
./forge go <slug> --user M        # create issues, for real
./forge show <slug>               # state, event timeline, cost
```

For the always-on experience — Feishu long connection, chat-message intake, card buttons for the whole flow, watchdog, status page — see [deploy/README.md](deploy/README.md) (`./forge listen`, `./deploy/install.sh`).

Forge treats the **target project as pluggable**: mechanical actions (creating issues, publishing docs, running CI) are delegated to the project's own scripts, or to the built-in native GitHub adapter (`gh`) for projects without them. Register multiple projects via `config/projects.yaml` ([example](config/projects.yaml.example)).

## Bring your own prompts (open-core seam)

The repo ships **generic default prompt templates** in [prompts/](prompts/). Every template can be overridden per deployment — and per project — without forking:

```bash
export FORGE_PROMPTS_DIR=/path/to/your/private-prompts
# resolution: $FORGE_PROMPTS_DIR/<project>/<name>.md → $FORGE_PROMPTS_DIR/<name>.md
#           → prompts/<project>/<name>.md → prompts/<name>.md
```

Point it at a private repo checkout and your tuned review methodology stays yours, while tracking this core. Golden evals (`./forge eval`) run against whichever set is active — fixtures in [fixtures/eval/](fixtures/eval/) pin the expected *shape* of gate output so prompt changes can't silently degrade the review.

## Keep the checkout clean (`FORGE_HOME`)

Config, state, and logs default to living **inside** the checkout. That's fine for a quick try, but it means your real `routing.yaml` sits on top of a tracked file — the checkout goes dirty and `git pull` starts conflicting.

`FORGE_HOME` moves all three out, so the core checkout stays read-only and disposable:

```bash
export FORGE_HOME=/path/to/your/forge-home    # → $FORGE_HOME/{config,state,logs}

# or move them individually (these win over FORGE_HOME):
export FORGE_CONFIG_DIR=/path/to/config
export FORGE_STATE_DIR=/var/lib/forge
export FORGE_LOGS_DIR=/var/log/forge
```

Golden eval samples move the same way, but as a **whole set** rather than per file — mixing your private PRDs with this repo's demo ones would make the pass rate meaningless:

```bash
export FORGE_EVAL_FIXTURES_DIR=/path/to/your/golden-prds   # replaces fixtures/eval entirely
```

Config resolves **per file**: a name present in your config dir wins, anything missing falls back to the repo's default in [config/](config/). Override only `routing.yaml` and the other three keep tracking this repo. With none of these set, every path is byte-for-byte what it was before — nothing to migrate.

> ⚠️ The fallback is silent by design. A typo in an overridden filename means you quietly run the repo default, not an error. If you keep a private overlay, have it reconcile its filenames against this repo's `config/` and `prompts/` trees.

## Repository layout

```
src/         statemachine · orchestrator · gates · review engine · llm drivers · store (SQLite)
             messaging port + feishu adapter · daemon · health/watchdog · drift · eval · project adapters
prompts/     externalized gate templates (override via FORGE_PROMPTS_DIR)
config/      runtime.yaml · routing.yaml · permissions.yaml · assignment.yaml (+ .example files)
             per-file fallback target when FORGE_CONFIG_DIR / FORGE_HOME is set
deploy/      launchd daemon + watchdog + bootstrap/install scripts
docs/        rationale · overview · control-plane architecture · downstream validation runbook
fixtures/    golden eval inputs + expected-shape assertions
test/        node:test suite (coverage floors enforced in CI)
```

## Development

```bash
npm run ci        # lint (biome) + typecheck (tsc strict) + tests with coverage floors
git config core.hooksPath .githooks   # pre-commit runs the same gate
```

Engineering rules — including "CI green before every commit" and the isolated-worktree contract — live in [AGENTS.md](AGENTS.md).

## Status & scope

Built and dogfooded as a single-maintainer service driving real multi-repo product development (Feishu + macOS launchd deployment). The upstream chain (Gates A/B, GO, multi-repo epics) and the downstream chain (Gates C/D) are implemented and test-covered; downstream end-to-end on a fresh build host is tracked in [docs/downstream-validation.md](docs/downstream-validation.md). Expect sharp edges outside that path — issues and PRs welcome.

## License

[Apache-2.0](LICENSE) © Angelo Zhang
