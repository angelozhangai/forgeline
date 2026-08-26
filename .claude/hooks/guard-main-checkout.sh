#!/bin/sh
# PreToolUse(Edit|Write|NotebookEdit) gate: stop an agent that starts writing **before** it has
# entered a worktree.
#
# It pairs with .githooks/lib/no-main-checkout.sh but plugs a different hole:
#   . pre-commit fires at commit time -- by then the changes are already piled up in the main
#     checkout and have to be stashed and moved;
#   . this one fires on the first keystroke, which is the cheapest possible moment.
# Claude Code's built-in worktree isolation only applies **once you are already inside a tree** (it
# then refuses writes back to the main checkout). The case it does not cover is never entering one,
# which is exactly the common case.
#
# Contract (Claude Code hooks docs): a JSON payload on stdin, a permissionDecision on stdout, exit
# 0. Allowing means printing nothing (the normal permission flow continues). Same escape hatch as
# pre-commit: FORGELINE_ALLOW_MAIN_CHECKOUT=1.
set -e

# Mind `set -e`: `[ cond ] && exit 0` exits 1 when false and the gate dies silently. if/fi.
if [ "${FORGELINE_ALLOW_MAIN_CHECKOUT:-}" = '1' ]; then exit 0; fi

payload="$(cat)"

field() { # field <path> -- no jq dependency (fall back to node, which this repo requires anyway)
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$payload" | jq -r "$1 // empty"
  else
    printf '%s' "$payload" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const p=process.argv[1].split(".");let v=j;for(const k of p)v=v?.[k];process.stdout.write(v==null?"":String(v))}catch{}})' "${1#.}"
  fi
}

cwd="$(field .cwd)"
file="$(field .tool_input.file_path)"
[ -n "$file" ] || exit 0
[ -n "$cwd" ] || cwd="$PWD"

main_root="$(cd "$cwd" 2>/dev/null && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
[ -n "$main_root" ] || exit 0 # not in a git repo (or git unavailable): do not block
main_root="$(dirname "$main_root")"
main_root="$(cd "$main_root" 2>/dev/null && pwd -P || printf '%s' "$main_root")"

# Relative paths resolve against cwd; the directory part is normalised with -P so that symlink
# differences such as /var vs /private/var do not cause a false verdict.
case "$file" in
  /*) abs="$file" ;;
  *) abs="$cwd/$file" ;;
esac
dir="$(dirname "$abs")"
if [ -d "$dir" ]; then abs="$(cd "$dir" && pwd -P)/$(basename "$abs")"; fi

case "$abs" in
  "$main_root"/*) ;;
  *) exit 0 ;; # outside the main checkout (so: already in a worktree) -- allow
esac

# These locations inside the main checkout are untracked runtime state, not "editing the code".
case "$abs" in
  "$main_root"/.forge/worktrees/*|"$main_root"/.claude/worktrees/*) exit 0 ;;
  "$main_root"/state/*|"$main_root"/logs/*|"$main_root"/node_modules/*) exit 0 ;;
  "$main_root"/.claude/settings.local.json) exit 0 ;;
esac

reason="Refusing to edit the main checkout (${main_root}) directly. Every change in this repo is made in an isolated worktree: run tools/wt.sh new <type>/<short-description> and work there. To override: FORGELINE_ALLOW_MAIN_CHECKOUT=1."
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
exit 0
