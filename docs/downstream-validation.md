# Downstream (Gate C / Gate D) Real-Build-Host Validation Runbook

> Purpose: on a **real build host**, run one end-to-end downstream smoke against a real target project —
> `DONE/bare issue →(implement)→ Gate C implement ⇄ local CI →(review-pr)→ open PR + Gate D adversarial review/hardening → AWAITING_HUMAN_MERGE →(human merge)→(merged)→ SHIPPED` —
> confirming that the **real external tools** — worktree/CI/PR/codex/claude — actually work on real code.

## Why this runbook exists

The downstream **orchestration wiring is already covered by unit/integration tests** ([test/downstream-production-flow.test.ts](../test/downstream-production-flow.test.ts) runs the full chain + the merge red line, with mocked drivers).
**What is not covered is "real external tools on real code"**: a real worktree (via the project's `wt.sh`), real local CI, real codex reviewing the diff, real claude changing code, a real PR being opened.
This can only be validated on a host that has **the project's full toolchain + credentials**, and it **costs money** (real claude/codex calls). If this machine is not a build environment (no `pnpm`, etc.), it cannot run — see the deploy-forge skill, **Gate 6b**.

⚠️ **This operation spends money and creates a real PR in the target project.** At no point does it auto-merge (the terminal state is `AWAITING_HUMAN_MERGE`; only after a human merges and runs `forge merged` does it reach `SHIPPED`).

## Prerequisites (confirm every one; none optional)

1. **The host is a real build environment for the project** (deploy-forge **Gate 6b**, item 2): `pnpm` / `direnv`/`.envrc` / `.secure-config` / a successful `pnpm install`.
   Verify by hand once: `./tools/scripts/wt.sh ../<proj>-probe -b throwaway origin/<base>` succeeds end to end (tree created, dependencies installed, CI script runnable), then clean up with `git worktree remove ../<proj>-probe` + `git branch -D throwaway`.
2. **The target repo's `origin` can be fetched non-interactively by Forge** (Gate 6b, item 1): `git -C <proj> fetch origin <base>` exits 0 with no interaction (if SSH is blocked by a proxy, switch to HTTPS + the gh credential helper).
3. **The downstream delegate scripts are registered in the project's entry in `config/projects.yaml`** (see [config/projects.yaml.example](../config/projects.yaml.example)): `scripts.{worktree_add,ci,diff,create_pr,checks}` paths correct and executable.
4. **CLIs are logged in**: `claude` (code changes/hardening), `codex` (diff review), `gh` (PR creation; the account has write access to the target repo). Re-check claude/codex/gh with `./forge doctor`.
5. **Permissions**: the triggering user is listed in `gate_c_allowed` / `pr_create_approvers` / `merge_ack_allowed` in [config/permissions.yaml](../config/permissions.yaml).
6. **Cost awareness**: one full Gate C implementation can reach several dollars; multi-round Gate D costs more. Set expectations and check `cost:` (sum across the four gates) anytime with `./forge show <slug>`.

## Pick a **small** issue for the smoke

Choose a real issue with a **small change surface and clear acceptance criteria** (don't pick a big requirement for the first run). Either entry point works:

- **Standalone (bare issue; recommended for the first validation)** — no upstream run required:
  ```bash
  ./forge implement --issue <org/repo#N|issue-url> --title "<short title>" \
      --project <projectId> [--repo <repo>] [--branch prod|dev] --user <you>
  ```
- **Chained (from upstream)** — the requirement is already `DONE` (upstream created the issues); simply:
  ```bash
  ./forge implement <slug> --user <you>
  ```

Both put the session into `GATE_C_REQUESTED`.

## Gate C: implement ⇄ local CI (isolated worktree)

```bash
./forge tick                 # automatic if the daemon is running; tick repeatedly by hand otherwise
./forge show <slug>          # watch state / cost / worktree_path / rounds
```

Observe tick by tick; the **expected state trajectory**:
`GATE_C_REQUESTED → GATE_C_RUNNING (worktree created) → GATE_C_LOOP (claude implements + runs CI; bounded self-fix rounds when red) → AWAITING_GATE_D (CI green)`.

**Things to verify**:
- `worktree_path` points to an isolated worktree outside the main checkout (created via the project's `wt.sh`).
- The `logs/<id>/gate-c.json` envelope: `implemented:true`, `ci_ok:true`, with `diff_stat`/`files_changed`.
- Reaching `AWAITING_GATE_D` means Gate C passed.

**Failure branches**:
- `AWAITING_GATE_C_INPUT`: the implementation escalated a human-in-the-loop question → `./forge gatec-answer <slug> --notes "…" --user <you>`, then keep ticking.
- `GATE_C_STALLED`: round cap reached with CI still red (never waved through) → inspect `gate_c_residual` + `logs/<id>/gatec-*.raw.txt`, adjudicate manually; fix the underlying issue, then `./forge retry <slug>`.
- `GATE_C_FAILED`: tree-creation/CI infrastructure error → check `error`; usually prerequisites 1/2/3 were not met.

## Gate D: open PR + adversarial review + hardening (**never auto-merge**)

```bash
./forge review-pr <slug> --user <you>   # requires pr_create_approvers; delegates to create_pr, never with auto-merge
./forge tick
./forge show <slug>
```

**Expected trajectory**:
`AWAITING_GATE_D →(review-pr)→ GATE_D_REQUESTED (PR opened; pr_url/pr_number recorded) → GATE_D_LOOP (codex reviews diff ⇄ claude fixes; CI must be green before any push) → GATE_D_HARDENING (inner-loop tests added + CI green + merge-readiness produced) → AWAITING_HUMAN_MERGE`.

**Things to verify**:
- A real PR appears in the target repo (`pr_url`) and is **not** auto-merged.
- Every pushed HEAD is CI-green (red/dirty never enters the PR; on failure it rolls back to the last green HEAD).
- `docs/delivery/<slug>/merge-readiness.md`: original requirement / design summary / diff stat / codex review summary / residual risks / rollback plan.

**Failure branches**: `AWAITING_GATE_D_INPUT` (`./forge gated-answer …`), `GATE_D_STALLED` (inspect `gate_d_residual`, adjudicate / `retry`), `GATE_D_FAILED` (PR-creation/CI infrastructure error).

## Human merge → SHIPPED

1. **A human** reviews the PR + merge-readiness on GitHub and, once satisfied, **merges manually** (Forge never merges for you).
2. After the merge, confirm back to Forge:
   ```bash
   ./forge merged <slug> --user <you>   # requires merge_ack_allowed
   ```
   → the isolated worktree is cleaned → `SHIPPED` → the drift loop follows (post-merge reconciliation of "merged implementation vs the Gate B acceptance contract", if `drift.enabled` is on).

## Pass criteria (a successful smoke)

- Gate C reached `AWAITING_GATE_D` (real worktree + real CI green).
- Gate D really opened a PR that was **not auto-merged**, ran codex review ⇄ claude fixes, produced a merge-readiness report, and stopped at `AWAITING_HUMAN_MERGE`.
- After the human merge, `forge merged` → `SHIPPED`, and the isolated worktree was cleaned.
- Nothing was silently waved through: every failure parked at `*_STALLED`/`*_FAILED` with the raw output preserved.

## Abort / cleanup / rollback

- **Abort anytime**: stop the daemon (`launchctl bootout …` or just stop ticking); the session stays parked in its current state; fix the underlying issue, then `./forge retry <slug>`.
- **Isolated worktrees**: terminal states (`SHIPPED`/`*_FAILED`) clean them up; for mid-run leftovers use `git -C <proj> worktree prune` + clean by `worktree_path`.
- **PR**: Forge never merges for you; if you don't want it, close the PR on GitHub + delete the branch (the wt.sh failure rollback no longer leaves orphan branches).
- **The Forge repo itself**: it only reads the target project's live checkout and changes code in isolated worktrees; it **never pushes the Forge repo itself**.

## After the first validation

Feed the results (time spent, $, prerequisite pitfalls hit) back into the deploy-forge skill Gate 6b / this document, so the next host runs smoother.
