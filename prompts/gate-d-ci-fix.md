The changes you just made in the worktree (`{{WORKTREE}}`) to satisfy codex's findings turned **local CI red**. The CI failure summary is below — **keep editing the files** to make it green again. Don't revert your fixes; make the fixes and CI compatible.

## Local CI failure

```
{{CI}}
```

## Discipline

- Only edit worktree files to turn CI green; keep the project rules (no `any`, comment language, reuse first, no unrelated refactors, failure/permission paths done right).
- **Never back out the fixes codex asked for just to appease CI** — the two must coexist.
- Do not open a PR, do not push, do not touch git.
- If it truly can't be fixed, or a trade-off needing a decision surfaces → list it in `needs_human`.

## Output (**output ONLY this JSON**)

```json
{
  "summary": "what this round changed to fix CI (one line)",
  "needs_human": []
}
```

Code changes go into the files, never into the JSON.
