# Forge Architecture Evolution: Decoupling the Target Project + Control-Plane/Execution-Plane Split

> This document is the **implementation source of truth**: it turns the decisions "two repos + control/runner split + reuse the your-monorepo backend" into an executable, phased path. Engineering discipline: [../CLAUDE.md](../CLAUDE.md); existing design: [../README.md](../README.md) / [RATIONALE.md](RATIONALE.md).
>
> Status: **Phase 0 in progress** (see the progress section at the end). Every increment must pass `npm run ci` fully green and preserve behavior (zero change under default configuration) before it is committed.

---

## 0. Decision summary (settled)

1. **Two repos**: Forge stays an independent repo and is **never merged into your-monorepo**. Rationale: role inversion (Forge orchestrates your-monorepo), keeping deployment-private prompt/method assets out of any product repo (this public repo ships generic default prompts; a deployment's tuned prompt sets live in a private overlay loaded via `FORGE_PROMPTS_DIR`), different release blast radii, and the open-source path.
2. **Reuse your-monorepo as a backend vendor, not as a host**: the Forge control plane **calls** your-monorepo's accounts/payments/orders (via API or a shared package); no Forge code lands in the your-monorepo product repo.
3. **Control plane / runner split**: Forge's work is inherently machine-bound (local checkout + local CLIs + worktrees + CI), so the best practice is "hosted control plane + a runner installed where the code lives" (the GitHub Actions runner model). This doubles as a selling point: **code/credentials never leave the customer's infrastructure**.
4. **The installable thing is a runner (like a CI runner), not an interactive CLI (unlike Claude Code)**; human interaction happens on the control plane's Web/IM asynchronous approvals.

---

## 1. Target architecture

```
              ┌──────────────────────────────────────────────────┐
 Feishu/Slack◄┤  CONTROL PLANE (hosted/central)                  │
 Web panel   ◄┤   • orchestration state machine + sessions/events → central DB
 GO/adjudicate◄┤  • gate/permission/routing policy + methodology · prompts (private IP)
              │   • accounts/orgs/RBAC/SSO + billing/orders/usage ◄── your-monorepo
              │   • board/cost (management plane) + notifications  │
              │            ▲ pull job        ▼ report events/cost/diff │
              └────────────┼──────────────┼──────────────────────┘
              ┌────────────┼──────────────┼──────────────────────┐
              │  RUNNER (installed where code+credentials+toolchain live) = today's forge daemon │
              │   • runs claude/codex/pi  • worktrees · CI · opens PRs │
              │   • holds credentials locally (claude/codex/gh/LLM keys) — never sent out │
              └──────────────────────────────────────────────────┘
                  customer's Mac mini / customer CI / customer VPC
```

| Plane | Responsibility | Status |
| --- | --- | --- |
| **Control plane** | State machine · policy · messaging · board · accounts/billing · prompts | Today scattered across sqlite + messaging + health; **to be extracted and centralized** |
| **Execution plane (runner)** | Runs CLIs · worktrees · CI · opens PRs · holds credentials locally | ≈ today's `forge listen`; **already largely formed** |

---

## 2. Three Port seams (all following the `MessagingPort` pattern: interface + a single selection point)

`MessagingPort` ([src/messaging/index.ts](../src/messaging/index.ts) one-line selection point + [port.ts](../src/messaging/port.ts) interface + [feishu.ts](../src/messaging/feishu.ts) adapter) is the proven pattern. Copy it to three places:

| Port | What it converges | Status (direct-access / hardcoded spots) | Target adapters |
| --- | --- | --- | --- |
| **ProjectActions** | Mechanical actions on the target project (create issue / set status / publish design / read PRD) | [src/workspace.ts](../src/workspace.ts) calls `bash(demo scripts)` directly; org/repoMap/umbrella hardcoded | `demoScript` (wraps the existing scripts) / `nativeGithub` (calls gh/API directly, for open-source users) |
| **SessionStore** ✅ | State reads/writes (get/create/patch/transition/event) | ~~direct sqlite access, no abstraction~~ → [store/port.ts](../src/store/port.ts) interface + [store/index.ts](../src/store/index.ts) selection point + [sessions.ts](../src/store/sessions.ts) `localSqliteStore` adapter (established in Phase 1) | `localSqlite` (status quo) / `remoteApi` (control-plane HTTP; needs the async interface variant) |
| **Vcs** | git worktree/fetch/checkout/anchor | [src/util/worktree.ts](../src/util/worktree.ts) + repoAnchor spawn git directly | `localGit` (status quo) / `runnerRpc` (control plane → runner) |

> The **LLM/harness layer** is already a black-box CLI ([runClaude](../src/llm/runClaude.ts)/runCodex) and naturally lives runner-side; multi-harness support (codex / claude code / pi) adds adapters at this layer, orthogonal to the three Ports above.

---

## 3. Integration boundary with your-monorepo

The control plane **calls** your-monorepo for four things, **all through seams, no code merged**:

| Need | Form (suggested) | Purpose |
| --- | --- | --- |
| Identity verification (users/orgs/members) | API (OAuth/JWT) or a shared `auth` package | Login, RBAC |
| Subscription/plan status | API | Gate permissions, feature flags |
| Usage metering (tokens/actions) | API (usage reporting) | Usage-based billing |
| Orders/invoices | your-monorepo owns them; Forge reads status only | Billing |

Forge's **orchestration brain + methodology prompts + runner** all live in the Forge repo; your-monorepo only supplies the mature "accounts/payments/orders" SaaS backend.

---

## 4. Implementation path (phased)

| Phase | What | When | Value |
| --- | --- | --- | --- |
| **0** | **Decouple the target project**: make org/repoMap/umbrella/path fully configurable; `ProjectActions` abstraction + native GitHub adapter | **Now** | Decouples demo ✓ multi-project (your-monorepo in a different org) ✓ multi-VCS / open-sourceable ✓ |
| **1** ✅ | `SessionStore` interface (local sqlite implementation unchanged, zero behavior change) — **done**: 1a establish the seam (interface + selection point + adapter), 1b migrate 20 consumers through the selection point + a mechanical guardrail. ⚠️ The interface is **synchronous** (a Phase 1 red line); the real remoteApi (async HTTP) needs the async variant, deferred to Phase 2 | Right after 0 | Prerequisite for centralized state |
| **2** 🚧 | Split the control/runner API; state into a central DB; runner pulls jobs | On customer signal (**started**: the JobSource seam is in place, see below) | Shared by on-prem and SaaS |
| **3** | Upgrade tenant isolation to a **security boundary** (per-tenant data/credentials/runner) + hook into your-monorepo billing | After the commercialization decision | SaaS landing |

---

## 5. Phase 0 detailed checklist (file-level, ordered)

> Principle: every step preserves behavior (default = status quo) and passes `npm run ci` fully green before moving on. Multi-project (your-monorepo) is the first real beneficiary — it is very likely a **different GitHub org**, so the org hardcoding must go first.

**0.1 — Make the GitHub `owner` (org) configurable (in progress)**
- [x] [config.ts](../src/config.ts): `ProjectEntry` gains `owner?: string`
- [x] [projects.ts](../src/projects.ts): `ProjectFull` gains `owner`; `DEFAULT_OWNER='your-org'` fallback; resolved in `project()`
- [x] [workspace.ts](../src/workspace.ts): `parseIssues`/`newReqSingle`/`newReqEpic`/`listEpicChildren`/`issueStates`/`addLabel` accept `owner` (fallback by default; production callers pass it)
- [x] [writes.ts](../src/writes.ts): `parseEpicChildren` + `doWrites` thread `projectForSession(s).owner` through
- [x] [drift/reconcile.ts](../src/drift/reconcile.ts): `issueStates` receives the project owner
- [x] **0.1b wrap-up**: org hardcoding in [llm/probes.ts](../src/llm/probes.ts) (`probeGh` uses the default project's owner) and [util/load.ts](../src/util/load.ts) (`probeLoad` receives it from actions per session project); doctor ([index.ts](../src/index.ts)) / contract ([health/contract.ts](../src/health/contract.ts)) copy strings made generic. ~~Leftover: load.ts `REPO_CODE`/`'example-project'` (repoMap/umbrella coupling)~~ → derived per project in "Phase 0 deep-water wrap-up"

**0.2a — `ProjectActions` Port + write-path migration (done)**
- [x] New [src/project/actions.ts](../src/project/actions.ts): `ProjectActions` interface + `makeDemoScriptActions(proj)` adapter (delegates to the workspace.ts script wrappers, **injecting scriptsDir/owner per project**)
- [x] Selection point [src/project/index.ts](../src/project/index.ts): `projectActions(proj)` — **receives an already-resolved ProjectFull (type-only dependency on projects.ts)**, avoiding mock brittleness
- [x] Migrated the write path: [writes.ts](../src/writes.ts) `doWrites`/`applySizeLabels` go entirely through the Port (scriptsDir/owner no longer hand-passed); workspace.ts remains the implementation body of the demo adapter, so tests using `mock.module('../src/workspace.ts')` still intercept **with zero changes**
- [x] Added [test/project-actions.test.ts](../test/project-actions.test.ts) covering the injection contract of every adapter method

**0.2b — Gate A / Gate B scaffolding migration (done)**
- [x] [gateA.ts](../src/gates/gateA.ts): `reviewReqScaffold` → `projectActions(proj).scaffoldReview`
- [x] [gateB.ts](../src/gates/gateB.ts): `techDesignScaffold` → `projectActions(proj).scaffoldTechDesign` (note: the scaffold's `--owner` is the document owner's login, not the GitHub org; the adapter injects only scriptsDir)
- [x] Note: `feishuRead/CommentAdd` (the feishu·doc layer) and `prMergeState`/`issueStates` (gh queries) are **not mechanical script actions** — they stay in workspace.ts or a separate query port, not forced into ProjectActions

**0.2c — `nativeGithubActions` adapter (for open-source / script-less projects)**
- [x] [src/project/github.ts](../src/project/github.ts): implements `ProjectActions` by calling gh directly, **self-contained** (imports only proc.run → avoids mock brittleness).
- [x] Configuration: `ProjectEntry.actions: 'demo'|'native'` (default demo) → `ProjectFull.actions` → the selection point switches adapters by `proj.actions`.
- [x] Tests: [test/project-actions-native.test.ts](../test/project-actions-native.test.ts) (adapter unit tests) + [test/writes-native-chain.test.ts](../test/writes-native-chain.test.ts) (**production-chain regression**: Gate B single-repo short code C → doWrites → native, asserting the real `gh -R owner/<mappedRepo>`).
- **Honest boundary (after scaffold completion)**:
  - ✅ **Single-repo full chain works**: `scaffoldReview/scaffoldTechDesign` natively generate the delivery docs (`req-review.md`/`tech-design.md`, including the `status: draft` line → the gates `appendMachineSection` append and `markReviewActive` set active; non-destructive, never overwrite existing files); `createSingle` maps short codes → real repo names via `repoMap`; `approve`/`publish` have no generic GitHub counterpart → **no-op returning ok**. So a native project can **walk the full gateA→gateB→GO chain single-repo** (the LLM gate loops are project-agnostic anyway; cwd=proj.root).
  - ✅ **Multi-repo Epic works end to end (Phase 0 deep-water closed)**: see "Phase 0 deep-water wrap-up" below — the `✓C#n` output contract was decoupled from doWrites, and native `createEpic` is implemented end to end.
- **Companion fix (Should-Fix)**: the `tech_design_publish` write path ([writes.ts](../src/writes.ts)) and the DONE copy ([actions.ts](../src/actions.ts)) now read the **project-level** `proj.techDesignPublish` (no longer the global runtime), so native/multi-project setups can disable publishing per project in `projects.yaml`.

**0.3 — De-hardcode paths / repo identity (done)**
- [x] [project.ts](../src/project.ts): the sibling `../example-project` fallback **now applies only to the default project**: non-default projects are forced to declare `root` explicitly by [config.ts](../src/config.ts) `ProjectsSchema.superRefine` (rejected at startup); only the default project auto-discovers its sibling.
- [x] `DEFAULT_REPO_MAP`/`DEFAULT_UMBRELLA` ([projects.ts](../src/projects.ts)) **fall back only for the default project**: non-default projects no longer inherit the demo repo letters / umbrella repo — `repoMap` defaults to `{}`, `umbrella` defaults to the project's own `repos[0]`. This fixes the hazard of your-monorepo and others silently receiving `{C:demo,…}`/`example-project` and pointing at the wrong repos. `projects.test.ts` + `projects.yaml.example` updated in step.
- [x] [util/load.ts](../src/util/load.ts): `probeLoad` now scans **that project's repos + umbrella** (passed from [actions.ts](../src/actions.ts) via `projectForSession(s)`), no longer hardcoding `cfg.runtime.repos`+`'example-project'`.

**0.3 review follow-ups, two Should-Fixes (done)**
- [x] **SF1 — local repo key ≠ GitHub slug**: `repos` (local keys/paths; `'.'` for a monorepo) were being used as GitHub repo names, producing `gh -R owner/.` (all your-monorepo workload probes failed → GO blocked by "no DRI assigned"). Added `ProjectEntry.repoSlugs` (local key → GitHub slug, default = key); [load.ts](../src/util/load.ts) `probeLoad` + native [createSingle](../src/project/github.ts) both resolve through it; the real config sets `your-monorepo.repoSlugs {'.':'your-monorepo'}`. Regression [test/load-probe.test.ts](../test/load-probe.test.ts) asserts `gh -R owner/your-monorepo`, never `owner/.`.
- [x] **SF2 — non-demo default project missing root**: the root-omission exemption now recognizes only the **built-in** `DEFAULT_PROJECT_ID` (demo), not "whatever `default_project` says in config" — otherwise setting a non-demo default while omitting root would pass the schema and silently fall back to the demo root at runtime. [config.ts](../src/config.ts) `superRefine` + [test/config.test.ts](../test/config.test.ts) regression.

**Phase 0 deep-water wrap-up (done)**
- [x] **Multi-repo native Epic + decoupling the `✓C#n` output contract**: the port contract became "`createEpic.issues` = Epic + all created child issues"; `doWrites` consumes `r.issues` directly and no longer knows any script output format. `parseEpicChildren` (the `✓C#n` parser) moved from [writes.ts](../src/writes.ts) into the demo adapter ([project/actions.ts](../src/project/actions.ts)) — it is a demo-script detail and belongs to the adapter. Native [createEpic](../src/project/github.ts) implemented end to end: Epic → umbrella repo, child issues → each code repo, all carrying `epic:<slug>` + DRI; any creation failure yields `ok=false` (no silent failure).
  - **Namespace contract**: the `CreatedIssue.repo` returned by `createSingle`/`createEpic` is always the **local repo key** (under demo, key = slug so nothing changes; under a monorepo, key=`'.'` ≠ slug `'your-monorepo'`). `doWrites` reasons in key/letter space throughout (the `expectedRepos` coverage check and size-label matching both live in key space); `addLabel`/`listEpicChildren` accept a key and translate to the slug when building `gh -R` — eliminating "coverage check mismatch when localKey ≠ slug".
  - Tests: [project-actions-native.test.ts](../test/project-actions-native.test.ts) (multi-repo Epic end-to-end / child-creation failure / dryRun), [project-actions.test.ts](../test/project-actions.test.ts) (demo merged `✓C#n` + direct `parseEpicChildren` tests), [writes-native-epic.test.ts](../test/writes-native-epic.test.ts) (native multi-repo production chain).
- [x] **Cross-stack letter mapping (`REPO_CODE`) derived per project**: `probeLoad` no longer hardcodes the demo repo→letter table; it derives "GitHub slug → letter" from the target project's `repoMap`+`umbrella`+`repoSlugs` and injects it into `scoreLoad`. Added `buildRepoCode` (letter → local key → slug; the umbrella repo is labeled `P` only when it does not collide with a code repo slug — in a monorepo the umbrella *is* the code repo, so the code letter is kept). `scoreLoad` gains an optional `repoCode` (falls back to the default `REPO_CODE`; pure-function direct-call tests unaffected). The `probeLoad` signature was tightened into a structured `ProbeRepoIdentity` (a structured subset, not importing `ProjectFull` → avoids mock brittleness). The demo derivation equals the old hardcoded table key by key (behavior unchanged); your-monorepo (`repoMap={}`) → its single repo maps to `P`, score-equivalent to the previous `'?'`.
- **Still open (needs real values, not a code problem)**: `your-monorepo.owner` still falls back to `your-org`; if your-monorepo is not in the your-org org, the real `projects.yaml` must set `owner: <org>` explicitly (config carries a ⚠️ comment). For your-monorepo to run native Gate A/B/GO (rather than serve only as a downstream C/D smoke target), it also needs an explicit `actions: native` + a matching `repoMap`.

### Phase 1 — the `SessionStore` seam (done)
Following the `MessagingPort` pattern (interface + single selection point + adapter), a thin seam for the state layer, paving the way for the control/runner split and centralized state.
- [x] **1a establish the seam**: [store/port.ts](../src/store/port.ts) (`SessionStore` interface; `NewSession`/`EventRow` sources of truth moved here) + a bundle at the end of [store/sessions.ts](../src/store/sessions.ts), `localSqliteStore` (the free functions remain — they are the localSqlite implementation) + the selection point [store/index.ts](../src/store/index.ts): `export const store = localSqliteStore`. Test [store-port.test.ts](../test/store-port.test.ts): selection-point methods are **reference-equal** to the free functions (zero drift), the seam surface is complete, and the full chain runs against real sqlite via `store.*`.
- [x] **1b migrate consumers**: 20 src consumers switched from direct sessions.ts access to going through `store/index.ts`. Namespace importers (9) use the alias `import { store as sessions }` (zero call-site changes); named importers (11) use `import { store }` + `const { patch,get } = store` (destructuring rather than re-exporting the free functions — a re-export would pin sqlite and bypass the seam when switching to remoteApi). Mechanical guardrail [store-seam-guard.test.ts](../test/store-seam-guard.test.ts): scans src (excluding store/) and asserts no file touches sessions.ts directly.
- **⚠️ Synchronous contract (a hard constraint of this phase)**: the interface methods return **synchronously** — matching the current direct sqlite access, so consumer migration causes zero behavior change (no cascading awaits). This is the Phase 1 "zero behavior change" red line. The real `remoteApi` (HTTP is inherently async) needs the **async variant** of this interface — that is the larger sync→async call-chain migration belonging to Phase 2 (the control/runner split), not this phase.
- **Outside the seam discipline**: `store.test`/`store-legacy-duplicates` and friends still test sessions.ts implementation details directly (`ALL_COLUMNS`/schema/migrations) — implementation unit tests; the guardrail governs src consumers only.

### Phase 2 — control plane / runner split (started)
Following the `MessagingPort`/`SessionStore` pattern, a thin seam for "where does the runner get due jobs". **JobSource (pull jobs) + SessionStore (report back) together form the complete control/runner data flow** (control plane emits jobs, runner executes, state returns to the center).
- [x] **JobSource seam (behavior-preserving)**: [jobs/port.ts](../src/orchestrator/jobs/port.ts) (`JobSource` interface; `claimDueJobs` fetches this round's due jobs = sessions in POLLER_DRIVEN states) + [jobs/local.ts](../src/orchestrator/jobs/local.ts) (`localJobSource` — local DB enumeration, reading through the SessionStore seam) + [jobs/index.ts](../src/orchestrator/jobs/index.ts) (selection point `jobSource`). `worker.tick`'s `ready` now goes through `jobSource.claimDueJobs()`, with a note that reclaim/retry/autonomy/remind/sweep/drift are **control-plane orchestration policies** (they stay on the control plane after the split), not runner jobs. Test [runner-jobsource.test.ts](../test/runner-jobsource.test.ts).
- [x] **Deep-water ① async JobSource**: `claimDueJobs(): Session[] → Promise<Session[]>` (the job pull is the first action of the runner's remote loop, so it goes async first; only 1 consumer, worker.tick, which is already async → zero behavior change).
- [x] **Deep-water ② remotePull vertical slice**: [jobs/remote.ts](../src/orchestrator/jobs/remote.ts) `makeRemoteJobSource(baseUrl)` (runner client, GET `<base>/jobs`) + `dueJobsPayload` (control-plane payload, sharing the wire contract). The selection point switches on `FORGE_CONTROL_URL` (set = pure runner / remotePull; unset = all-in-one status quo). No silent failure (network / non-2xx / bad JSON / invalid job all throw) + external input is never trusted (validated). Real HTTP loopback round-trip test [runner-remote-jobs.test.ts](../test/runner-remote-jobs.test.ts). **Honest boundary**: `dueJobsPayload` is not yet mounted on the production control-plane server (health/server.ts) — mounting + network exposure/auth lean deployment-side, later.
- [x] **Deep-water ③ async SessionStore (report-back side)**: the IO methods of the [store/port.ts](../src/store/port.ts) interface now return Promises (exception: the pure predicates `isDuplicate*Error` stay sync); the free functions in [store/sessions.ts](../src/store/sessions.ts) became async, awaiting internal cross-calls. **~277 call sites migrated mechanically, guided by tsc/lint**: 24 src consumers (gates/worker/actions/CLI/listen/intake/notify/drift/board/server/action-gateway) + the reviewFixLoop callback contract + 32 test files all await. Floating promises (biome) cleared to zero (a store write missing an await is a real bug). **Semantic behavior preserved** (localSqlite stays synchronous underneath, wrapped as async; awaiting a sync value = same value, same order). Also picked up a tick.lock parallel-test flake in passing (FORGE_LOCK can override the lock path). lint+typecheck+test:cov fully green (825/821/4 skipped).
- [x] **Deep-water ④ remoteApi SessionStore (runner reads/writes control-plane state over HTTP)**: [store/remote.ts](../src/store/remote.ts) `makeRemoteStore(baseUrl, token?)` (runner client implementing the same `SessionStore`) + `handleStoreCall(impl, body)` (control-plane dispatch end) + a `REMOTE_METHODS` allowlist. They share **a single RPC envelope** wire contract, `POST <base>/store {method,args}` → `{ok,result|error}` (an RPC envelope was chosen over per-resource REST: SessionStore is an **internal control/runner RPC interface** — 19 methods, one dispatch point in strict lockstep, zero route drift; follows the jobs/remote.ts pattern). Selection point [store/index.ts](../src/store/index.ts) switches on `FORGE_CONTROL_URL` (set = pure runner / remoteApi; unset = all-in-one sqlite status quo, **behavior unchanged**). **Business errors (illegal transition / UNIQUE index collision) travel back as `ok:false` + the original message** (not HTTP 4xx; 2xx always means "the server processed it") → the client rebuilds the Error so the `isDuplicate*Error` pure predicates still classify across the network (never over the wire; the client runs the regex locally on the rejected error); network / non-2xx / bad JSON / non-allowlisted method / non-array args always throw or reject (**no silent failure** + **never trust external input**). Real HTTP loopback round-trip test [remote-store.test.ts](../test/remote-store.test.ts) (10 cases: full chain + per-method name alignment + cross-network predicate fidelity + injection/bad-input protection + unreachable/non-2xx throwing).
- [x] **Deep-water ⑤ control-plane server (mounting /jobs + /store in a runnable process + auth)**: [control/server.ts](../src/control/server.ts) `startControlServer({port,host,token})` — the minimal runnable body of the control-plane process, **independent of** health/server.ts (the runner's local status page). `GET /jobs` + `POST /store` (= `handleStoreCall(store, body)`) + `GET /healthz` (unauthenticated probe). **Auth boundary**: with a token configured, /jobs+/store require `Authorization: Bearer <token>` (`timingSafeEqual` fixed-length comparison against timing side channels); on the runner side, `makeRemoteStore/JobSource(url, token)` + the selection point reads `FORGE_CONTROL_TOKEN`. **Two fail-closed guards**: ① binding to a non-loopback address without a token → throws at startup; ② the process has `FORGE_CONTROL_URL` set (the runner marker) → throws at startup (guaranteeing the control plane's `store`/`jobSource` are always the local implementations, never proxied elsewhere). CLI `forge control [--port][--host]` ([index.ts](../src/index.ts), configured via FORGE_CONTROL_*). Real HTTP loopback test [control-server.test.ts](../test/control-server.test.ts). **Honest boundary**: ① control plane and runner can still run on the same machine (process split, not yet truly deployed cross-machine); ② `forge control` is a new process role, not yet wired into launchd/deploy scripts (deployment side, later).
- [x] **Deep-water ⑥ leases (multi-runner double-claim protection)**: `claimDueJobs` changed from a pure read into an **atomic claim** — the first change to core tick behavior on the control/runner line. New `SessionStore.leaseClaim(states, runnerId, ttlMs, limit)` ([store/sessions.ts](../src/store/sessions.ts)): a single `UPDATE...RETURNING` (with a subquery `ORDER BY created_at ASC LIMIT`) takes the due jobs that are "state ∈ states ∩ (unowned / expired / self-held)", **FIFO, at most `limit`**, leasing and returning them — another runner's unexpired leases are excluded → **never double-claimed**; sqlite statement-level atomicity + the control plane's single serialized connection guarantee no double claim across processes. Sessions gain `lease_owner`/`lease_expires_at` columns (schema.sql + db.ts column backfill + types.ts + ALL_COLUMNS). Runner identity + TTL live in the neutral little module [jobs/runner.ts](../src/orchestrator/jobs/runner.ts) (`RUNNER_ID`=`FORGE_RUNNER_ID`‖host:pid; `leaseTtlMs()`=`FORGE_LEASE_TTL_SEC`‖7200s). `localJobSource`/`makeRemoteJobSource`/the control plane's `/jobs?runner=<id>&limit=N` thread runner identity and capacity all the way through. **Three lease-management mechanisms** (no separate renew/release needed): ① each tick's self-held branch **renews** loops in flight; ② holder dies → expired leases get **reclaimed**; ③ transitioning out of POLLER_DRIVEN → no longer claimable + expires naturally. **Single-runner behavior preserved**: only the lease columns are additionally written; **updated_at is never bumped** (that would wipe the remindStuck idle detection). Tests: [lease.test.ts](../test/lease.test.ts) + a control-server multi-runner no-double-claim loopback.
  - **Blocker fix ① bounded claim** (caught in review): `limit = max_parallel` (passed by worker.tick) — **claim only what this round will actually run concurrently, never lease the whole backlog at once**. Otherwise queued-but-not-started jobs would have their TTL counting down from claim time, get dragged past the TTL by a long step ahead of them → another runner reclaims them as expired → the same worktree runs twice; and one runner would monopolize the backlog, so multiple runners never share it. FIFO favors older jobs (fair; retried old jobs go first). Every claimed job starts immediately (no queueing) → the lease window ≈ a single step, the "TTL ≥ one step" sizing holds, and the backlog spreads naturally. Throughput: the tick lock is serial anyway and runLimited already batches, so "claim max_parallel per tick, continue next tick" is throughput-equivalent to the old "whole batch" (just a few more rounds of the 180s periodic tick).
  - **Blocker fix ② control-plane orchestration runs only on the control plane / all-in-one** (caught in review): reclaim/retry/autonomy/remind/sweep/drift inside `tick()` are **gated on `!pureRunner`** (`pureRunner` = `FORGE_CONTROL_URL` is set) — a pure runner skips them and runs only the job loop. Otherwise each of several runners' ticks would concurrently run these control-plane write actions (leases only protect the job loop, not these → duplicate retries / duplicate autonomy-created issues / sweeps stepping on each other). Default (no `FORGE_CONTROL_URL`) = all-in-one, everything runs, **zero behavior change**.
  - **Runnable topology (review Should-Fix: aligned to real processes)**: **the control-plane machine = `forge listen` with `FORGE_CONTROL_PORT`** — one process = the full orchestration tick + its own job loop + the control-plane HTTP (/jobs+/store) serving additional runners ([daemon/listen.ts](../src/daemon/listen.ts) starts `startControlServer`; single sqlite connection, no multi-process contention). **An additional runner = `forge listen` on another machine + `FORGE_CONTROL_URL`** (pure runner: skips orchestration, runs only the job loop, pulls jobs / reads-writes state over HTTP). `forge control` is the standalone variant that **serves only the HTTP surface and runs no orchestration** — running it alone as the control plane would leave orchestration with nobody to run it; a `forge listen` must exist on the same sqlite (hence the docs no longer present "`forge control` + pure runners" as a complete control plane).
  - **Honest boundary**: ① within a single **very long step** (no tick boundary to renew at), a job can still be stolen past the TTL — the TTL defaults to 2h and is tunable (forge.env.example); for heavy downstream work it must be ≥ the longest single step. ② True cross-machine **has not been run end to end** (control plane + runner validated on the same machine so far); but this is ops/packaging work, **not gated on a central DB** — remote runners read/write state over HTTP, so a single control plane + sqlite can serve cross-machine runners (see [§8 Storage](#8-storage--central-db-postgres--when-to-migrate-and-what-it-means)).
- **⚠️ Next (gated on customer signal; two items, mutually independent)**: ① **Deployment** — containerized/hosted control plane + runner install scripts + a true cross-machine end-to-end run (pure ops, **not gated on a central DB**). ② **Central DB (Postgres/managed)** — needed only when the control plane wants **multi-instance/HA** or **managed persistence**, and **never a prerequisite for "multiple runners"** (multiple runners already work over HTTP). See [§8 Storage](#8-storage--central-db-postgres--when-to-migrate-and-what-it-means). Both change the deployment model and cannot be fully behavior-preserving.

---

## 6. Red lines / invariants (unbroken in any Phase)

- **Forge never pushes its own repository** (top-level iron rule); prompt/method assets never land in your-monorepo or any product repo — this repo ships generic default prompts, and a deployment's privately tuned prompt sets stay in a `FORGE_PROMPTS_DIR` overlay (see [src/util/render.ts](../src/util/render.ts)).
- **Behavior preservation**: zero behavior change under default configuration in Phase 0/1 (single project = status quo).
- **No silent failure**: parse/external-call failures keep parking as `*_FAILED` with the raw output preserved.
- **SaaS tenant isolation must be a security boundary, not `project_id` query filtering**: today's multi-tenancy (query filtering + a global poller) is valid only for "you, one operator, running multiple projects"; with multiple paying customers, each tenant gets independent data/credentials/runner. **Global poller/drift/orphan sweep: fine within one organization, absolutely not across paying customers.**
- **Never auto-merge / never skip deterministic gates / never adjudicate on a human's behalf** (the progressive-autonomy red lines) — unchanged.

---

## 7. Progress

- **Phase 0.1**: owner made configurable (write + drift paths) — see branch `feat/decouple-target-project`.
- Everything else: pending.

---

## 8. Storage / central DB (Postgres) — when to migrate, and what it means

> Keywords (for searchability): **storage / database / DB / central DB / Postgres / PG / sqlite / persistence**. Any future discussion of switching databases, adopting Postgres, or externalizing state starts by reading this section.

**Conclusion (2026-06; not migrated, migrate on demand)**: **Do not migrate to Postgres now — and do not migrate for the sake of "multiple runners / cross-machine deployment" either.** PG only makes sense when the control plane itself needs **multi-instance/HA** or **managed persistence/operations**; it is scaling/hardening for the control plane, **not a prerequisite for the control/runner split**.

### Current state
- The state store = **a local single-file sqlite** (`node:sqlite`, `state/service.db`; `store/db.ts` + the `localSqliteStore` in `store/sessions.ts`).
- **Only the one control-plane process touches it**, over a **single connection with statement-level atomicity**. Cross-process mutual exclusion for leases relies on this single connection + sqlite file locking.

### Why "multiple runners / cross-machine runners" do **not** need PG (counterintuitive, but by design)
Deep-water ④⑤ decoupled runners from the DB via HTTP:
```
remote runner ──HTTP /jobs + /store──▶ control-plane process ──single connection──▶ sqlite
(store=remoteStore,                    (the only one touching the DB)
 jobSource=remoteJobSource)
```
Once a runner has `FORGE_CONTROL_URL` set, its `store`/`jobSource` are pure HTTP clients and **the process never opens the sqlite file** (not a single `localSqlite` method is called). Worktrees/credentials live on the runner's local FS, unrelated to the DB. So "**one control-plane process + its local sqlite + N (even cross-machine) runners over HTTP**" — **sqlite is enough**. The scenario sqlite cannot handle ("multiple processes across machines contending for the same file") is exactly what the HTTP arrangement avoids.

### When a central DB (Postgres/managed) becomes **genuinely** necessary — migration triggers
Move only when at least one of these holds, backed by a real signal:
1. **Multi-instance control plane (HA / horizontal scaling)**: you want ≥2 control-plane processes (redundancy/scaling) sharing the same state — a single sqlite file cannot span processes/machines → an external DB is needed. Note: a single control-plane process only orchestrates + emits jobs + serves read/write RPC (no heavy compute); it can carry the load for a long time, so this may not come early.
2. **Managed persistence / operations**: a real SaaS wants managed backups, replication, PITR, monitoring, zero-downtime maintenance — a single sqlite file is on the fragile side (Forge has online backup, `store/backup.ts`, as a backstop, but it is no match for managed PG).
3. **The single process + sqlite becomes an unacceptable SPOF / write bottleneck.**

**Not migration reasons** (already satisfied by the HTTP arrangement): multiple runners, cross-machine runners, one control plane serving many runners.

### What migrating would mean (cost / effort)
- Abstract the direct `node:sqlite` access (the `prep()` in `store/sessions.ts`) into a **storage driver interface** and add a **Postgres adapter** (connection pool + migrations + SQL dialect). The `SessionStore` interface is already async (deep-water ③) and already converges on the `store/index.ts` selection point — **the seam is in place; swapping backends touches no consumers**, but the underlying rewrite is substantial.
- **Leases map naturally onto PG**: the current `UPDATE...WHERE id IN (SELECT...ORDER BY created_at LIMIT)` can upgrade to `SELECT ... FOR UPDATE SKIP LOCKED` on PG (stronger concurrent-claim semantics); cross-process atomicity moves from "a single sqlite connection" to "a PG transaction".
- ⚠️ **Locally unverifiable**: this repo's CI is **offline sqlite** with no PG instance → PG adapter code **cannot be validated locally at all**. Migrating without a real deployment target = piling up unverifiable speculative code, violating "only call it done once it's verified".

### Decision gate
Whether to migrate is **not a head-down coding question** — it is the product/deployment decision "**do we want multiple control-plane instances / managed persistence**". Move once that decision exists (+ a reachable PG instance); until then, a single control plane + sqlite + HTTP remote runners is the complete and verifiable configuration.
