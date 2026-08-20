Keep working in the same isolated worktree (`{{WORKTREE}}`). Below are codex's findings for **this round** (or the owner's decision). **Continue editing the files in the worktree** accordingly.

## The owner's decision (if any)

{{HUMAN_ANSWER}}

## codex's findings this round

{{FINDINGS}}

## Discipline

- Respond to every finding; keep following the project rules you read last round (no `any`, comment language, reuse first, no unrelated refactors, failure/permission paths done right).
- **CI must stay green** — forge runs CI, and red means parking for a human. Only edit files — do not open a PR, do not push, do not touch git.
- Product/architecture/trade-off/risk points still unsettled, or deadlocked with codex → list them in `needs_human` (never guess).

## Output (**output ONLY this JSON**)

```json
{
  "summary": "what this round changed (one line)",
  "needs_human": []
}
```

Code changes go into the files, never into the JSON.
