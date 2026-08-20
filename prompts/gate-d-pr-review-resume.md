Keep reviewing the same PR (you have seen it before). The implementer changed the code per your last round's findings and updated the branch.

## Workspace

`{{WORKTREE}}` (read-only; the change range is still `{{BASE}}..HEAD`)

## This round

Re-run `git diff {{BASE}}..HEAD` to see the **current** full change set (including this round's new commits). Judge only:

1. Whether your last round's findings are **actually** fixed (don't trust the self-report — read the code).
2. Whether this round's new changes **introduced new problems** (bug / contract / security / mirror tests / missing failure or permission paths).

Unresolved or new problems → `CHANGES_REQUESTED` and list them; truly nothing to change → `LGTM`.

## Output (**output ONLY this JSON**)

```json
{
  "verdict": "LGTM | CHANGES_REQUESTED",
  "findings": [{ "severity": "high|med|low", "issue": "the problem", "where": "file:line", "fix": "suggested change", "evidence": "code evidence" }]
}
```

LGTM ⇔ findings must be empty; CHANGES_REQUESTED ⇔ findings must have at least one entry.
