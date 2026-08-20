## Code source of truth (read the latest refs — never the local working tree)

The service ran `git fetch origin` for the repos at {{FETCHED_AT}}. **Read only the refs below** (they are the freshest remote source of truth); do not read each repo's local working tree (it may be dirty/stale):

{{REPO_REFS}}

How to read: use `git -C <repo> show <ref>:<path>`, or `git -C <repo> checkout` first (read-only analysis, no modifications). Prefer `grep`/`show` against the pinned ref to avoid interference from uncommitted local changes.
