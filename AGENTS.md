# Forgeline — engineering rules

> What the service is, the state machine, and usage live in [README.md](README.md). This file is the
> single source of truth for **commit/quality discipline** (Claude Code / Codex and humans all read it;
> `CLAUDE.md` points here — never fork a second copy that can drift).

## 🏠 Top rule: Forge is a generic service; mechanical actions are delegated to the "target project"

**Forge orchestrates; the target project provides the mechanical actions** (scripts / skills / conventions).
Forge always calls the project's existing implementation instead of re-creating it in this repo. The bundled
default target is a sibling checkout at `../example-project`; point `FORGE_PROJECT_ROOT` (or
`config/projects.yaml`) at your own project(s). Forge reads the project's live checkout, so script or
convention updates in the project are picked up immediately.

## 🌲 Top rule: isolated worktrees belong to the specific repo they change — hidden dir, never tracked

**The repository is the most specific unit.** Downstream Gate C/D worktrees must be created under the repo
they actually modify — never hardcoded to "the first repo", never piled into the umbrella repo or a sibling dir.

- **Which repo**: implementation anchors to the repos the requirement really touches — chained runs take
  Gate A's `repos_touched ∩ proj.repos`, standalone runs take `--repo`, persisted as `session.target_repos`
  (json `string[]`). Multi-repo requirements get **one tree per repo**. Only an empty/missing set falls back
  to `proj.repos[0]`.
- **Where**: `<repoDir>/.forge/worktrees/<key>` (the repo's own hidden dir); `key` derives from the unique
  `session.id` via `gateC.implIdentity()`.
- **Never tracked**: excluded via the repo's **local** `.git/info/exclude` (`ensureWorktreeExcluded`) — local
  to this machine, never committed, and Forge **never edits a product repo's tracked `.gitignore`** (Forge
  leaves no stray changes or commits in product repos).
- **Sweep/cleanup walks all `proj.repos`**: orphans may sit under any repo's `.forge/worktrees/`.
- Source of truth: [src/util/worktree.ts](src/util/worktree.ts) (paths/exclusion/orphan decisions) and
  [src/gates/gateC.ts](src/gates/gateC.ts) (`resolveTargetRepos`/`primaryTargetRepo`/setup). Change those +
  their tests together.

## 🚦 Top rule: local CI must be green before every commit

**Run `npm run ci` (= `lint` + `typecheck` + `test:cov`, with coverage floors) before `git commit`.
Red never gets committed.**

- Mechanical backstop: `.githooks/pre-commit` runs `npm run ci` on every commit and rejects red.
- Enable once per clone: `git config core.hooksPath .githooks`.
- Remote runs the same checks: GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)) on PRs
  and pushes to main, plus `npm run audit` (dependency vulnerability gate; needs registry access, so remote-only).
- Emergency bypass requires an explicit `git commit --no-verify` with the reason stated in the PR/commit.
- **Green is only meaningful if everything actually ran.** `npm run ci` puts `test:cov` behind
  [tools/test-with-floor.sh](tools/test-with-floor.sh), which fails when the reported test count drops
  below `TEST_COUNT_FLOOR`. This exists because `--test-force-exit` used to kill the runner before some
  files reported — the same commit reported 875 / 875 / 856 tests on consecutive runs and said `fail 0`
  every time. **Never add `--test-force-exit` back**, and never "fix" a floor failure by lowering the
  floor: the floor is a ratchet, raise it when you add tests, lower it only deliberately with a stated
  reason. If the runner ever hangs instead, that's the leak this flag was hiding — find the open handle;
  a loud hang beats a silent green.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run ci` | **Pre-commit gate**: lint + typecheck + test:cov behind a test-count floor (same set as remote CI) |
| `npm run lint` | Biome lint (incl. `noFloatingPromises`; curated rules in `biome.json`) |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm test` | `node:test` unit + integration (fast, no coverage) |
| `npm run test:cov` | Same + coverage floors (lines 75 / branches 72 / functions 75) |
| `npm run audit` | Dependency vulnerability gate (high+, needs network; remote CI runs it) |
| `./forge <cmd>` | Service CLI (see README) |

## Conventions

- **Runtime**: Node ≥ 24; TypeScript runs directly (type stripping, no build step); restrained dependencies
  (`yaml` / `zod` / Feishu SDK).
- **Tests move with the implementation**: when touching modules with external contracts (e.g.
  `src/util/sizing.ts`), update the matching tests in the same change — don't let `test/` drift (CI catches
  it, but catch it locally first).
- **No silent failures**: parse/external-call failures park the session in a `*_FAILED` state with the raw
  output persisted — never swallowed (see README design notes).
- **Write actions only fire on human GO**: on GO, the tech-design doc is published to the target project's
  main repo (via the project's own script; disable with `runtime.yaml` `tech_design_publish.enabled:false`),
  then issues are created; failures park as `WRITE_FAILED` without creating issues.
- **Private prompt overlays**: the repo ships generic default prompts; deployments may point
  `FORGE_PROMPTS_DIR` at a private directory to override any template without forking
  (see [src/util/render.ts](src/util/render.ts)).
- **Deployment dirs are a seam, not a constant**: config/state/logs resolve through
  `FORGE_HOME` (or `FORGE_CONFIG_DIR` / `FORGE_STATE_DIR` / `FORGE_LOGS_DIR`) in
  [src/root.ts](src/root.ts); config additionally falls back **per file** to the repo's `config/`.
  Two rules when touching this: **(a)** never read `CONFIG_DIR` directly to build a config path —
  use `configFile(name)`, or you break the fallback for everyone with a partial overlay;
  **(b)** with none of the vars set, every path must stay byte-identical to the in-checkout
  layout — that backward-compat case is pinned by [test/deploy-dirs.test.ts](test/deploy-dirs.test.ts)
  and is what lets a fresh clone just work.
