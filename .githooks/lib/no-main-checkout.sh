#!/bin/sh
# Gate 1 before a commit: **no commits in the main checkout.** Every change happens in an isolated
# worktree.
#
# Why this has to be mechanical: the rule is written in AGENTS.md, but a rule only binds whoever
# read it. The day it actually bit us nobody had broken anything -- the shared checkout was holding
# 9 uncommitted files when #17 merged into main, and the two collided. Discipline does not stop
# that; a hook does, because humans, Claude, Codex and every future agent all go through the same
# git.
#
# Start new work with: tools/wt.sh new <type>/<short-description>
# To commit in the main checkout anyway (and mean it):
#   FORGELINE_ALLOW_MAIN_CHECKOUT=1 git commit ...
set -e

# Mind `set -e`: `[ cond ] && exit 0` returns 1 when the condition is false, so the gate would exit
# "rejected" silently and block everything. Written as if/fi on purpose.
if [ "${FORGELINE_ALLOW_MAIN_CHECKOUT:-}" = '1' ]; then exit 0; fi

git_dir="$(git rev-parse --absolute-git-dir 2>/dev/null || true)"
common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -z "$git_dir" ] || [ -z "$common_dir" ]; then exit 0; fi # cannot tell: let it through rather than wedge git

# A worktree's git-dir is <common>/worktrees/<name>; equal paths mean this is the main checkout.
[ "$git_dir" = "$common_dir" ] || exit 0

cat >&2 <<'MSG'

  x Do not commit in the main checkout.

    Every change in this repo is made in an isolated worktree (AGENTS.md top rule). The main
    checkout is for reading code and running git pull -- the moment it goes dirty, everyone else
    (including your own other session) collides with it when main moves.

    Start new work:
      tools/wt.sh new <type>/<short-description>   # e.g. tools/wt.sh new fix/mention-gate
      tools/wt.sh new --issue 42                   # slug derived from the issue title

    Already edited the main checkout and want to move it:
      git stash && tools/wt.sh new <slug> && cd "$(tools/wt.sh path <slug>)" && git stash pop

    Really commit here (emergency -- say so in the PR):
      FORGELINE_ALLOW_MAIN_CHECKOUT=1 git commit ...

MSG
exit 1
