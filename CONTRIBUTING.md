# Contributing to Forgeline

Thanks for looking at this. Two documents matter before you write anything:

- **[README.md](README.md)** — what the service is, the state machine, how to run it.
- **[AGENTS.md](AGENTS.md)** — the engineering rules. It is the single source of truth for commit and
  quality discipline, and `CLAUDE.md` just points at it. Humans and coding agents read the same file.
  If you edit a skill under `.claude/skills/`, copy it to `.agents/skills/` **in the same commit** — CI
  asserts the two trees are byte-identical, so Claude Code and Codex can never be given different rules.

Everything below is the short version of AGENTS.md. Where the two disagree, AGENTS.md wins.

## English only

**Code, comments, commit messages, PR titles and bodies, issues, docs, config comments and every string
the service emits are written in English.** This is an open core: downstream integrators build against
`src/ext/port.ts` and `src/messaging/port.ts` without patching core files, and a contract they cannot
read is not a contract.

The line that matters: **source is English, input is not.** A requirement document arriving over Feishu
or Slack can be in any language and must keep working exactly as well as it does today. Non-English text
belongs in tests as escapes or generated strings, never as literal source.

`test/english-only.test.ts` enforces this — a tracked file carrying CJK, kana or hangul turns CI red and
names the `file:line`. Emoji are fine.

## Before you commit

```sh
npm run hooks   # once per clone — installs .githooks; without it there is NO local gate and no warning
npm run ci      # lint + typecheck + test:cov behind a test-count floor. Red never gets committed.
```

Node ≥ 24 is required (TypeScript runs directly, no build step). `npm run ci` is the same set the remote
runs, so a green local run should mean a green PR.

If you add tests, **raise `TEST_COUNT_FLOOR`** in [tools/test-with-floor.sh](tools/test-with-floor.sh).
The floor is a ratchet: never "fix" a floor failure by lowering it.

## Pull requests

`main` moves only by merging a PR — a server-side ruleset and `.githooks/pre-push` both enforce it.

- Branch, commit, open a PR. Keep the PR description focused on **why**, not a restatement of the diff.
- Commit messages follow the shape already in `git log`: a `type(scope): summary` subject, then a body
  explaining the reasoning and any trap the change avoids.
- Tests move with the implementation. If you touch a module with an external contract, update its tests
  in the same change.
- An emergency bypass needs an explicit `git commit --no-verify` **with the reason stated in the PR**.

## Extending Forgeline

Do not patch core files to add downstream behaviour. AGENTS.md has a four-level table (L0–L3) for where
a need should land; most things are L0 or L1 and require no change here at all. Adding an IM provider or
a document source is one adapter file plus one line at the registration point — if it needs more, the
port is wrong and that is the bug worth reporting.
