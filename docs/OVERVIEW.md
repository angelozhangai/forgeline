# Forge at a Glance: Features / Maturity / Roadmap (Status Overview)

> **This document is a "current-state snapshot + navigation index", not a source of truth.** Every fact points to its real source (README / design docs / code / tests); this document only aggregates them into **a single panoramic view**, answering four questions: **which features exist, which are solid, which still need work, and what is planned.**
>
> Source-of-truth split: service / state machine / design highlights → [README.md](../README.md); commit & quality discipline → [CLAUDE.md](../CLAUDE.md); why it is built this way → [RATIONALE.md](RATIONALE.md) + [self-built-harness-tradeoff.md](self-built-harness-tradeoff.md); architecture evolution / control-plane split / storage → [architecture-control-plane-split.md](architecture-control-plane-split.md); downstream real-host validation → [downstream-validation.md](downstream-validation.md).
>
> Snapshot date: **2026-06-27** (branch `feat/decouple-target-project`). Where this document conflicts with a source of truth, **the source of truth wins** — when you spot drift, fix the source of truth first, then backfill this document.

**Maturity legend**: ✅ landed with test coverage | 🟡 implemented, awaiting real-host end-to-end validation / partially complete | 🔭 design settled, not implemented (future plan, gated on real signal)

---

## 1. One sentence and positioning

**Forge is a "PRD review → tech design → implementation → PR → merge-ready" domain orchestration pipeline. It writes no code itself — it orchestrates two world-class coding agents (Claude Code + Codex, via their CLIs) to review each other, backstops them with deterministic gates, keeps a human in the loop throughout, and never auto-merges.**

It is **not** an agent harness (that is the Claude Code / Codex / pi layer); it is the **business pipeline layer** that sits on top of the harnesses: a persistent state machine that spans days and gates, can park and retry, plus domain semantics (PRD idempotency, four gates, size/confidence, Feishu cards, issues/PRs, drift reconciliation).

**Three legs of value** (drop any one and a whole class of errors slips through; see [RATIONALE.md](RATIONALE.md)):

1. **Heterogeneous cross-review** (claude ⇄ codex adversarial) — catches "plausible-looking but wrongly reasoned" (subjective correctness);
2. **Deterministic gates** (CI green / outer-loop acceptance turned green / types / zero Blockers, never skippable) — catches "both agents agree, but reality disagrees" (objective correctness);
3. **Closed-loop eval measurement** (golden samples + judge + baseline A/B) — guards "the rented engines change under you every day; overall quality must not regress as models/prompts drift" (correctness over time).

---

## 2. End-to-end pipeline (four-gate state machine)

Full state machine / transition diagram: [README, state machine section](../README.md); the state enum's source of truth is [src/statemachine/states.ts](../src/statemachine/states.ts). In one line:

```
PM posts PRD ─▶ Gate A (review requirements against the code source of truth + multi-round PM replies + codex adversarial review) ─▶ CONFIRMED
             ─▶ Gate B (tech design + codex⇄claude adversarial rounds + outer-loop acceptance contract + issue draft) ─▶ AWAITING_GO
             ─▶ human GO ─▶ create issues (DONE)
── downstream ──
             ─▶ Gate C (implement in an isolated worktree ⇄ local CI until green) ─▶ AWAITING_GATE_D
             ─▶ Gate D (open PR + codex reviews diff ⇄ claude fixes + harden inner-loop tests + merge-readiness) ─▶ AWAITING_HUMAN_MERGE
             ─▶ human merge ─▶ SHIPPED ─▶ drift reconciliation (approved ≠ delivered; close the loop)
```

**Human pause points** (first-class citizens): answering open questions round by round (PM), forced finish / adjudication (M), triggering Gate B (permission-gated), answering Gate B/C/D escalations (M), one-click GO (permission-gated), triggering implement / review-pr (permission-gated), and **the human merge** (never automatic). Everything else is driven by the poller (`forge tick` / the resident `forge listen`).

---

## 3. Feature inventory × maturity

### 3.1 Intake / wiring / idempotency
| Feature | Status | Source of truth |
| --- | --- | --- |
| Manual `add --prd` (register a PRD link) | ✅ | [src/intake.ts](../src/intake.ts) |
| Auto-intake from group chat (paste a link → `addPrd`) | 🟡 requires an "@bot" mention / bot-token trigger | [src/messaging/backfill.ts](../src/messaging/backfill.ts), [daemon/listen.ts](../src/daemon/listen.ts) |
| Offline backfill after disconnect/sleep (incremental per-chat cursor) | ✅ | [src/messaging/backfill.ts](../src/messaging/backfill.ts) (provider-agnostic loop) |
| **PRD-level idempotency** (doc-token normalization for dedupe + partial unique index as a concurrency backstop) | ✅ | [src/intake.ts](../src/intake.ts), [src/store/sessions.ts](../src/store/sessions.ts) |

### 3.2 Upstream: Gate A (requirements review)
| Feature | Status | Source of truth |
| --- | --- | --- |
| Find gaps / open questions against the code source of truth + PRD quality scoring (internal, management plane) | ✅ | [src/gates/gateA.ts](../src/gates/gateA.ts), [prompts/gate-a.md](../prompts/gate-a.md) |
| Multi-round PM review loop (`--resume` saves tokens; parks for adjudication at `max_pm_rounds`) | ✅ | [src/gates/gateALoop.ts](../src/gates/gateALoop.ts) |
| Codex adversarial review (`GATE_A_ADVERSARIAL`, reuses the generic engine) | ✅ | [src/review/reviewFixLoop.ts](../src/review/reviewFixLoop.ts) |
| Checkout anchoring (`anchorCheck`; offsets disclosed / parked) | ✅ | [src/gates/repoAnchor.ts](../src/gates/repoAnchor.ts) |
| No silent pass when the code source of truth is unavailable (`assertFresh`; fetch with backoff retry) | ✅ | [src/gates/repoFreshness.ts](../src/gates/repoFreshness.ts) |

### 3.3 Upstream: Gate B (tech design + outer-loop acceptance)
| Feature | Status | Source of truth |
| --- | --- | --- |
| Tech design draft + codex⇄claude multi-round adversarial loop (`--resume` on both sides) | ✅ | [src/gates/gateB.ts](../src/gates/gateB.ts), [gateBLoop.ts](../src/gates/gateBLoop.ts) |
| Human-in-the-loop escalation (`needs_human` → `AWAITING_GATE_B_INPUT`) / `GATE_B_STALLED` adjudication at the round cap | ✅ | same |
| **Outer-loop acceptance contract** (`contracts` + declarative `Given/When/Then`, written into the issue as the definition of done) | ✅ | [src/util/acceptance.ts](../src/util/acceptance.ts) |
| Deterministic light validation before GO (empty outer loop / imperative phrasing / missing repo → blocks GO; `--force` overrides with an audit trail) | ✅ | [src/util/acceptance.ts](../src/util/acceptance.ts), [src/actions.ts](../src/actions.ts) |
| Gate A → Gate B composed into a single "PRD source of truth" document (pure-function concatenation; parks if the write goes bad) | ✅ | [src/gates/prdTruth.ts](../src/gates/prdTruth.ts) |

### 3.4 GO / issue creation (write actions)
| Feature | Status | Source of truth |
| --- | --- | --- |
| One-click GO (permission gate) + `--dry-run` preview | ✅ | [src/actions.ts](../src/actions.ts) |
| Idempotent issue creation (`created_issues` persisted; retry skips re-creation) | ✅ | [src/writes.ts](../src/writes.ts) |
| Multi-repo Epic (create Epic + child issues + coverage check on both first run and retry + rediscovery by `epic:<slug>` to backfill missing children) | ✅ | [src/writes.ts](../src/writes.ts), [src/project/actions.ts](../src/project/actions.ts) |
| No silent failure on issue writes (non-zero script exit / label failure / missing child issue → `WRITE_FAILED`) | ✅ | [src/writes.ts](../src/writes.ts) |
| Auto-assign DRI (probed via `workload`; GO blocked while unassigned) | ✅ | [src/util/assign.ts](../src/util/assign.ts), [src/util/load.ts](../src/util/load.ts) |
| Auto-publish the tech design doc to the target project's main repo (config-gated; default behavior in CLAUDE.md) | ✅ | `scripts/publish-tech-design.sh` (target-project side) |

### 3.5 Downstream: Gate C (implementation + local CI) / Gate D (PR adversarial review + hardening)
| Feature | Status | Source of truth |
| --- | --- | --- |
| Gate C: implement in an isolated worktree ⇄ local CI until green (bounded self-fix rounds when red; circuit breaker to `STALLED` at the cap) | 🟡 orchestration + red lines tested; **real-host end-to-end pending** (costs money) | [src/gates/gateC.ts](../src/gates/gateC.ts), [gateCLoop.ts](../src/gates/gateCLoop.ts) |
| Isolated worktrees belong to their specific repo, live under `<repoDir>/.forge/worktrees/`, locally excluded so they never enter version control | ✅ | [src/util/worktree.ts](../src/util/worktree.ts), [src/gates/gateC.ts](../src/gates/gateC.ts) (see the top-level rules in [CLAUDE.md](../CLAUDE.md)) |
| Gate D: open PR (**never auto-merge**) + codex reviews the diff ⇄ claude fixes (push only when CI is green) | 🟡 same; real-host pending | [src/gates/gateD.ts](../src/gates/gateD.ts), [gateDLoop.ts](../src/gates/gateDLoop.ts) |
| Gate D inner-loop test hardening (no mirror testing) + merge-readiness report | 🟡 same | [src/gates/gateDHarden.ts](../src/gates/gateDHarden.ts), [prompts/gate-d-harden-tests.md](../prompts/gate-d-harden-tests.md) |
| Standalone bare-issue entry (no upstream run required) | ✅ | [src/actions.ts](../src/actions.ts) `requestGateC` |
| **Never-auto-merge red line** (terminal state `AWAITING_HUMAN_MERGE`; only a human `merged` produces `SHIPPED`) | ✅ test-covered | [test/downstream-production-flow.test.ts](../test/downstream-production-flow.test.ts) |
| Full-chain orchestration + red-line test coverage (DONE→C→PR→D→AWAITING_HUMAN_MERGE→SHIPPED) | ✅ | same |

> The Gate C/D "orchestration wiring" is fully tested; **what is not covered is the real external tools on real code** (real worktree/CI/codex/claude/PR creation) — that can only run on a build host with the project's full toolchain + credentials, costs money, and follows the [downstream-validation.md](downstream-validation.md) runbook.

### 3.6 Drift reconciliation (closing the "approved ≠ delivered" loop)
| Feature | Status | Source of truth |
| --- | --- | --- |
| After `SHIPPED`/`DONE`, check whether every `created_issues` entry is CLOSED; anchor to `prod` (main) and reconcile "merged implementation vs the Gate B acceptance contract" | ✅ implemented + tested, **off by default** (on = automatic spend + automatic DMs to M) | [src/drift/reconcile.ts](../src/drift/reconcile.ts), [prompts/drift-audit.md](../prompts/drift-audit.md) |
| Classified handling of obsolete closures + bounded backoff (`poll_every_hours`/`max_polls`) + recorded to events only, never polluting the main flow | ✅ | same |

### 3.7 Resident daemon / operations / keepalive
| Feature | Status | Source of truth |
| --- | --- | --- |
| `forge listen` resident daemon (Feishu long connection + periodic tick + backfill) | ✅ | [src/daemon/listen.ts](../src/daemon/listen.ts) |
| Card buttons drive the entire flow in place of the CLI (confirm / draft design / GO / answer / adjudicate) | ✅ | [src/messaging/feishu.ts](../src/messaging/feishu.ts), [src/messaging/operators.ts](../src/messaging/operators.ts) |
| launchd auto-start on boot + watchdog (rescues hangs; gated on a running grace period so tokens are not burned for nothing) | ✅ | [deploy/](../deploy/), [src/health/watchdog.ts](../src/health/watchdog.ts) |
| Local status page + `forge health` liveness check + heartbeat | ✅ | [src/health/server.ts](../src/health/server.ts), [heartbeat.ts](../src/health/heartbeat.ts) |
| Business-level reconciliation of parked states (untouched > 6h → debounced card re-send, covering the "Feishu was down at the moment of notification" hole) | ✅ | [src/health/](../src/health/) |
| Node failures classified transient/permanent + backoff auto-retry + dead letter + poison-pill protection (`reclaim_count`) | ✅ | [src/orchestrator/retry.ts](../src/orchestrator/retry.ts) |
| Install/deploy BLOCKING checklist skill | ✅ | `deploy-forge` skill, [deploy/README.md](../deploy/README.md) |

### 3.8 Web operations panel
| Feature | Status | Source of truth |
| --- | --- | --- |
| Board + full request list (state filter) + per-item detail (event timeline + state-appropriate actions) | ✅ bound to 127.0.0.1 | [src/health/board.ts](../src/health/board.ts) |
| Write action `POST /api/action` reuses the real actions' permissions/lint/red lines (no second implementation of the gates) | ✅ | [src/health/action-gateway.ts](../src/health/action-gateway.ts) |
| Security: same-origin Origin gate + `application/json` (blocks CSRF); no cost/score data included | ✅ | same |

### 3.9 Messaging / Feishu (a thin transport seam)
| Feature | Status | Source of truth |
| --- | --- | --- |
| `MessagingPort` interface + a single selection point (the core never touches any Feishu tag/JSON) | ✅ | [src/messaging/port.ts](../src/messaging/port.ts), [index.ts](../src/messaging/index.ts) |
| Feishu as the only adapter (card rendering + event parsing converge here) | ✅ | [src/messaging/feishu.ts](../src/messaging/feishu.ts) |
| Provider-agnostic `CardModel` (decision forms / stat rows / callback buttons / findingList…) | ✅ | [src/messaging/model.ts](../src/messaging/model.ts) |
| Slack/Teams and other provider adapters | 🔭 interface reserved; pluggable without touching a line of core | — |

### 3.10 Progressive autonomy
| Feature | Status | Source of truth |
| --- | --- | --- |
| `autonomy.level`: L1 auto-draft design / L2 auto-GO / L3 auto-start implementation / L4 auto-open PR | ✅ **default 0, fully manual**; overridable per project | [src/statemachine/autonomyPolicy.ts](../src/statemachine/autonomyPolicy.ts), [worker.applyAutonomy](../src/orchestrator/worker.ts) |
| Red lines unbroken at every level (never auto-merge / never skip deterministic gates / never adjudicate on a human's behalf; auto-GO never passes `--force`) | ✅ | same (red lines in [§8](#8-red-lines--invariants-never-broken-in-any-phase-at-any-autonomy-level)) |
| Every automatic action records an `autonomy_auto_triggered` audit event, attributed to `autonomy.actor` | ✅ | same |

### 3.11 Multi-tenant / multi-project (per-project differentiation)
| Feature | Status | Source of truth |
| --- | --- | --- |
| Config differentiation: `ProjectEntry` partially overrides `permissions`/`routing`/`assignment` (no override = the global reference is returned; zero change for single-project setups) | ✅ | [src/projects.ts](../src/projects.ts), [src/config.ts](../src/config.ts) |
| Query isolation: `listAll(projectId?)` + board/cost/CLI (`--project`) / panel (`?project=`) all filter by `project_id` | ✅ | [src/store/sessions.ts](../src/store/sessions.ts) |
| Decoupled target project: owner/repoMap/umbrella/path/repoSlugs fully configurable (Phase 0 complete) | ✅ | [config/projects.yaml.example](../config/projects.yaml.example) |
| `ProjectActions` Port + demo script adapter / **native gh adapter** (for open-source / script-less projects) | ✅ single-repo full chain + multi-repo Epic end-to-end | [src/project/actions.ts](../src/project/actions.ts), [src/project/github.ts](../src/project/github.ts) |
| Real security-boundary isolation (per-tenant data/credentials/runner, hooked into your-monorepo billing) | 🔭 Phase 3, after the commercialization decision | [architecture §4](architecture-control-plane-split.md) |

> ⚠️ **Red line**: today's multi-tenancy is "query filtering + a **global** poller/drift/orphan sweep" — valid only for "one operator running multiple projects". With multiple paying customers, tenant isolation **must be upgraded to a security boundary**; `project_id` filtering is never enough.

### 3.12 Control-plane / runner split (architecture evolution)
| Feature | Status | Source of truth |
| --- | --- | --- |
| `SessionStore` seam (interface + selection point + localSqlite adapter, now async) | ✅ Phase 1 + deep-water ③ | [src/store/port.ts](../src/store/port.ts), [index.ts](../src/store/index.ts) |
| `JobSource` seam (runner pulls jobs; now async + remotePull slice) | ✅ Phase 2 deep-water ①② | [src/orchestrator/jobs/](../src/orchestrator/jobs/) |
| `remoteApi` SessionStore (runner reads/writes control-plane state over HTTP; single RPC envelope) | ✅ deep-water ④ | [src/store/remote.ts](../src/store/remote.ts) |
| Control-plane server (`/jobs` + `/store` + `/healthz` + Bearer auth + two fail-closed guards) | ✅ deep-water ⑤ | [src/control/server.ts](../src/control/server.ts) |
| **Lease-based multi-runner double-claim protection** (atomic `UPDATE...RETURNING` + bounded claim + control-plane orchestration runs only on the control plane) | ✅ deep-water ⑥ | [src/store/sessions.ts](../src/store/sessions.ts), [jobs/runner.ts](../src/orchestrator/jobs/runner.ts) |
| True cross-machine end-to-end run (control plane + runner deployed on different machines) | 🔭 pure ops, **not gated on a central DB**; gated on customer signal | [architecture §5, deep-water ⑥ honest boundary](architecture-control-plane-split.md) |

### 3.13 Storage / persistence
| Feature | Status | Source of truth |
| --- | --- | --- |
| Local single-file sqlite (`node:sqlite`, no native dependencies) + online backup + migrations | ✅ | [src/store/db.ts](../src/store/db.ts), [backup.ts](../src/store/backup.ts) |
| Central DB / Postgres (needed only for multi-instance control-plane HA / managed persistence) | 🔭 **not migrating now — and not for "multiple runners" either**; the seam is in place, migrate when actually needed | [architecture §8](architecture-control-plane-split.md) |

### 3.14 Quality discipline (guardrails)
| Feature | Status | Source of truth |
| --- | --- | --- |
| `npm run ci` (lint + typecheck + test:cov, coverage floors 75/72/75) + pre-commit hook backstop | ✅ | [CLAUDE.md](../CLAUDE.md), [.github/workflows/ci.yml](../.github/workflows/ci.yml) |
| Test volume: **106 test files** (including many `*-production-flow` production-chain regressions) | ✅ | [test/](../test/) |
| Golden eval (golden samples + LLM judge + baseline A/B trend; guards the prompt assets against regression) | ✅ comparison logic runs in ci; a real `forge eval` run costs money and is manual | [src/eval/](../src/eval/), [fixtures/eval/](../fixtures/eval/) |
| Interface-drift probes (has the CLI `--json` schema changed?) | ✅ | [src/llm/probes.ts](../src/llm/probes.ts), [src/llm/contract.ts](../src/llm/contract.ts) |
| Architecture-boundary guardrails (store-seam direct-access scan and other mechanical guards) | ✅ | [test/store-seam-guard.test.ts](../test/store-seam-guard.test.ts), [arch-boundary.test.ts](../test/arch-boundary.test.ts) |

### 3.15 Cost / management plane (internal; never exposed outward)
| Feature | Status | Source of truth |
| --- | --- | --- |
| `forge cost` aggregates claude fixer $ across the four gates (A/B/C/D) per request, bucketed by state | ✅ | [src/cost.ts](../src/cost.ts) |
| PRD quality score (0–100, 4 dimensions) + per-person `workload` (visible only inside this service) | ✅ | [src/util/scoring.ts](../src/util/scoring.ts), [src/util/sizing.ts](../src/util/sizing.ts) |

---

## 4. Full CLI command set

Sources of truth: [src/index.ts](../src/index.ts) (dispatch) + [src/actions.ts](../src/actions.ts) (action implementations).

**Lifecycle**: `add` · `tick` · `show` · `list` · `answer` · `confirm` · `gateb` · `gateb-answer` · `gateb-go` · `assign` · `go` · `deny` · `implement` · `gatec-answer` · `review-pr` · `gated-answer` · `merged` · `retry`
**Management plane / read-only**: `scores` · `cost` · `size` · `workload` · `board`
**Ops / daemon**: `doctor` · `listen` · `health` · `status-page` · `watchdog` · `contract-check` · `control` (control-plane HTTP process)
**Quality**: `eval`

---

## 5. Full configuration set

Source of truth: [config/](../config/).

| File | What it governs |
| --- | --- |
| [runtime.yaml](../config/runtime.yaml) | Concurrency caps, branch mapping, `adversarial.max_rounds`, `gate_a.max_pm_rounds`, `retry.*`, `poll_interval_sec`, `health.*`, `autonomy.*`, `drift.*`, `delivery_doc_commit`, CLI name |
| [routing.yaml](../config/routing.yaml) | Gate A routing: cross-repo / `sensitive_areas` / low confidence → escalate to M; otherwise DRI self-review |
| [permissions.yaml](../config/permissions.yaml) | `gate_b_allowed`/`go_approvers`/`gate_c_allowed`/`pr_create_approvers`/`merge_ack_allowed` |
| `projects.yaml` (see [projects.yaml.example](../config/projects.yaml.example)) | Multi-project registry (root/repos/branches/owner/repoMap/umbrella/repoSlugs/scripts/chats/per-project overrides) |
| [assignment.yaml](../config/assignment.yaml) | DRI pool / assignment policy |
| `forge.env` (see [forge.env.example](../config/forge.env.example)) | Feishu bot/webhook, `FORGE_PROJECT_ROOT`, `FORGE_HEALTH_PORT`, `FORGE_CONTROL_*`, `FORGE_RUNNER_ID`, `FORGE_LEASE_TTL_SEC`, etc. (gitignored) |
| `weekly-overrides.tsv` (see [weekly-overrides.tsv.example](../config/weekly-overrides.tsv.example)) | Weekly manual corrections to per-person workload |

Per-project prompt variants: `prompts/<projectId>/<name>.md`, falling back to the default `prompts/<name>.md`. A deployment can additionally point the `FORGE_PROMPTS_DIR` environment variable at a private overlay directory whose files take precedence over the in-repo defaults (resolution order in [src/util/render.ts](../src/util/render.ts)).

---

## 6. What still needs work (🟡 implemented but unvalidated / partially complete)

1. **Downstream Gate C / Gate D real-host end-to-end validation** — orchestration + red lines are tested, but real worktree/CI/codex/claude/PR creation on real code **has never been run**; it needs a build host + full toolchain + credentials, and **costs money**. Run a small smoke issue following the [downstream-validation.md](downstream-validation.md) runbook.
2. **True cross-machine control plane + runner** — the control-plane/runner processes are split (deep-water ①–⑥ including leases), but everything so far has been **validated on one machine**; true cross-machine is ops/packaging work (containerization + runner install scripts + network exposure/auth). **Not gated on a central DB.**
3. **Trigger-free group-chat intake** — the current entry relies on an "@bot" mention / bot-token history reads (see the downstream roadmap).

---

## 7. Future plans (🔭 design settled, gated on real signal)

**Near-term (product features)**
- **PM entry without @**: switch to a user token + `im:message:readonly` so a PM can simply paste a link (no @ mention) to start a review.
- **Team scale-out (unattended Mac mini)**: switch claude to `setup-token`, configure non-interactive auth for codex, multiple chats.

**Architecture (gated on customer signal; see [architecture-control-plane-split.md](architecture-control-plane-split.md))**
- **Deployment**: containerized/hosted control plane + runner install scripts + a true cross-machine end-to-end run.
- **Central DB (Postgres/managed)**: migrate **only** when the control plane needs multi-instance/HA or managed persistence; the seam is in place. It is a product/deployment decision, not head-down coding (and the local offline CI cannot validate a PG adapter — don't write one without a real target).
- **Phase 3 tenant security boundary + your-monorepo billing integration**: after the commercialization decision.

**Strategy (judgment calls, not a settled roadmap)**
- **Open-source core + multiple harness adapters (codex / claude code / pi) + multiple messaging adapters**: tears down several adoption walls ("single harness / Feishu-only / tight coupling / single-language docs / demo script conventions"); the architecture already reserves the seams.
- **Commercial positioning**: sell a "vendor-neutral, governable AI delivery pipeline that never lets AI merge code behind your back" (governance/trust), **not** "yet another code-writing agent" (a red ocean). Open-core split: the skeleton is open source (this repo ships generic default prompts), while a deployment's tuned prompt sets and methodology can stay in a private overlay loaded via the `FORGE_PROMPTS_DIR` environment variable (see [src/util/render.ts](../src/util/render.ts)) — which also resolves the tension between keeping prompt assets private and open-sourcing the engine.
- Open questions: the first paid form factor (hosted SaaS vs on-prem), the exact open-source boundary for prompts, the minimal internationalization set.

---

## 8. Red lines / invariants (never broken in any Phase, at any autonomy level)

1. **Prompt/method assets can stay private per deployment**: this repo ships generic default prompts; a deployment's tuned prompt sets live in a private overlay loaded via the `FORGE_PROMPTS_DIR` environment variable (see [src/util/render.ts](../src/util/render.ts)) and are never committed into this repo or any product repo.
2. **Never auto-merge / never skip a deterministic gate (CI not green) / never adjudicate on a human's behalf** for `*_STALLED`, or answer `*_INPUT` for them.
3. **No silent failure**: any parse/external-call failure parks as `*_FAILED` with the raw output preserved.
4. **Behavior preservation**: zero behavior change under default configuration in Phase 0/1 (single project = status quo).
5. **SaaS tenant isolation must be a security boundary, not `project_id` query filtering**; the global poller/drift/orphan sweep may be global within one organization, never across paying customers.
6. **Deterministic gates are never skippable; the human may step back gradually** (the single inviolable constraint of progressive autonomy).

Sources of truth: [CLAUDE.md](../CLAUDE.md) top-level rules + [architecture §6](architecture-control-plane-split.md) + [README, progressive autonomy](../README.md).

---

## 9. Source-of-truth index (which file answers which question)

| To learn about | Look at |
| --- | --- |
| How to use the service / state machine / design highlights | [README.md](../README.md) |
| Commit / quality discipline (single source of truth) | [CLAUDE.md](../CLAUDE.md) |
| Why not build a harness / why cross-review | [RATIONALE.md](RATIONALE.md) |
| What a self-built harness looks like (empirical comparison) / why eval is the third leg | [self-built-harness-tradeoff.md](self-built-harness-tradeoff.md) |
| Control-plane/runner split path / storage / Postgres timing | [architecture-control-plane-split.md](architecture-control-plane-split.md) |
| How to run downstream real-host validation | [downstream-validation.md](downstream-validation.md) |
| State enum / transitions | [src/statemachine/states.ts](../src/statemachine/states.ts), [engine.ts](../src/statemachine/engine.ts) |
| CLI entry / actions | [src/index.ts](../src/index.ts), [src/actions.ts](../src/actions.ts) |
