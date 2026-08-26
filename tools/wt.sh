#!/usr/bin/env bash
# The **single** entry point for creating a worktree in this repo: one requirement / one issue = one
# isolated tree.
#
# Why it has to be one script: three conventions used to coexist here --
#   1. Claude Code's built-in `.claude/worktrees/<name>` (it also forces a `worktree-` branch prefix,
#      and only Claude knows about it);
#   2. the Gate C/D trees this service creates inside a *target project* repo at
#      `<repo>/.forge/worktrees/<key>` (which says nothing about forgeline's own checkout);
#   3. humans and Codex editing the shared main checkout directly -- so `main` moved under someone
#      who had uncommitted files sitting in it.
# Three conventions is no convention. This collapses them into one: **everyone -- every human, every
# agent -- lands in `<mainCheckout>/.forge/worktrees/<key>`, through this script.**
#
# Same shape as the AGENTS.md top rule it mirrors: a worktree belongs to the repo it actually
# changes, lives in that repo's own hidden directory, and is never tracked. The creation discipline
# is copied from src/util/worktree.ts too: the base is always pinned to an **immutable sha**, never a
# moving ref like origin/main -- a concurrent fetch moves the baseline and upstream's new commits
# then read as your own changes.
#
# Agent contract: **stdout carries the path (or the --json object) and nothing else**; everything
# written for a human goes to stderr.
set -euo pipefail

# git exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE to every hook it runs, and this script *is*
# run from pre-commit. Left in place they hijack `git -C <path>` back to whatever repository invoked
# the hook, so every path below would be resolved against the wrong tree. Resolution here is
# cwd-based and needs none of them.
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR GIT_PREFIX

# -- output contract ---------------------------------------------------------------------------
note() { printf '%s\n' "$*" >&2; }
die() { printf '\n  x %s\n\n' "$*" >&2; exit 1; }
out() { printf '%s\n' "$*"; }

usage() {
  cat >&2 <<'USAGE'
Usage: tools/wt.sh <command> [args]

  new <slug> [opts]      Create (or reuse) a worktree. The slug is the branch name verbatim; '/'
                         becomes '-' in the directory name.
                         --issue <n>   derive the slug from a GitHub issue title (needs gh)
                         --type <t>    branch prefix used with --issue (default: feat)
                         --base <ref>  baseline to branch from (default: origin/<default branch>)
                         --no-install  skip npm ci (on by default: without node_modules the
                                       pre-commit local CI cannot run)
                         --offline     do not fetch; use the refs already present
                         --json        print a JSON object on stdout instead of a bare path
  list [--json]          List every worktree under this convention (branch / dirty / ahead / behind).
  check [--fix]          **The detector.** Fail if any worktree of this repo sits outside
                         .forge/worktrees/, if that directory is not ignored, or if git hooks are
                         not enabled. --fix relocates stray trees with `git worktree move`.
  rm <slug|path> [--force]
                         Remove one. Refuses while it holds uncommitted or unpushed work.
  sweep [--days N] [--yes]
                         Remove merged, clean, old trees. Dry-run until --yes.
  doctor                 Health check: prune/repair, ignore rule, hooksPath, dependencies, check.
  path <slug>            Print the path for a slug without creating anything.
  hook-create            Read Claude Code's WorktreeCreate JSON on stdin, create, print the path.
  hook-remove            Read a WorktreeRemove JSON on stdin and remove the tree.

Environment: WT_NO_INSTALL=1 equals --no-install; WT_OFFLINE=1 equals --offline.
USAGE
}

# -- repository anchor -------------------------------------------------------------------------
# Called from the main checkout or from inside any worktree, always anchor to the **main checkout**:
# git's common dir is the main checkout's .git.
resolve_main_root() {
  local common
  common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [ -z "$common" ]; then # older git has no --path-format: absolutise by hand
    common="$(git rev-parse --git-common-dir)"
    common="$(cd "$common" && pwd)"
  fi
  dirname "$common"
}

git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository."
MAIN_ROOT="$(resolve_main_root)"
WT_ROOT="$MAIN_ROOT/.forge/worktrees"
GIT="git -C $MAIN_ROOT"

default_branch() {
  local ref
  ref="$($GIT symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [ -n "$ref" ]; then printf '%s\n' "${ref##*/}"; else printf 'main\n'; fi
}

# -- slug / key --------------------------------------------------------------------------------
# The identifier is used **verbatim** (unlike Claude Code's built-in, which prepends `worktree-`):
# the tree, the branch and the PR should all name the same thing, or sessions cannot line them up.
# Only '/' is rewritten, because a directory name cannot carry it.
key_of() { printf '%s\n' "${1//\//-}"; }

validate_slug() {
  local slug=$1
  case "$slug" in
    ''|-*|*..*|*/|/*|*' '*) die "invalid slug: '$slug' (no empty / leading - or / / '..' / spaces / trailing /)" ;;
  esac
  [ "${#slug}" -le 64 ] || die "slug too long (>64): $slug"
  $GIT check-ref-format --branch "$slug" >/dev/null 2>&1 || die "slug is not a valid branch name: $slug"
}

slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' \
    | sed -e 's/[^a-z0-9]\+/-/g' -e 's/^-*//' -e 's/-*$//' | cut -c1-40
}

# -- ignore guarantee --------------------------------------------------------------------------
# Belt and braces: the tracked .gitignore carries `.forge/` (this is our own repo, editing our own
# .gitignore is fair game), and this machine's .git/info/exclude backs it up in case that line is
# ever removed. Creating a tree under a non-ignored directory turns the whole checkout into
# untracked files.
ensure_ignored() {
  if ! $GIT check-ignore -q .forge/probe 2>/dev/null; then
    local ex="$MAIN_ROOT/.git/info/exclude"
    mkdir -p "$(dirname "$ex")"
    printf '\n# isolated worktrees (this machine, never committed)\n/.forge/\n' >>"$ex"
  fi
  $GIT check-ignore -q .forge/probe 2>/dev/null \
    || die ".forge/ is not ignored by git -- refusing to create a tree under a non-ignored directory."
}

# -- bootstrap: what a fresh checkout is missing ------------------------------------------------
# A new tree is a clean checkout: no gitignored secrets/config, no node_modules. Without those the
# pre-commit local CI cannot even start, so creation has to finish the job.
# node_modules is installed with npm ci and **never symlinked**: .gitignore's `node_modules/` only
# matches directories, so a symlink surfaces as an untracked file -- and once a branch's lockfile
# diverges, a shared symlink is a wrong-version bug that is very hard to see.
copy_includes() {
  local dest=$1 manifest="$MAIN_ROOT/.worktreeinclude" line src
  [ -f "$manifest" ] || return 0
  while IFS= read -r line; do
    line="${line%%#*}"; line="${line#"${line%%[![:space:]]*}"}"; line="${line%"${line##*[![:space:]]}"}"
    [ -n "$line" ] || continue
    src="$MAIN_ROOT/$line"
    [ -f "$src" ] || continue
    # Only gitignored files are carried: a tracked file is already in the checkout, and copying it
    # again just manufactures a fake diff.
    $GIT check-ignore -q "$line" 2>/dev/null || { note "  . skipping ${line} (not gitignored)"; continue; }
    mkdir -p "$(dirname "$dest/$line")"
    cp -p "$src" "$dest/$line"
    note "  . carried $line"
  done <"$manifest"
}

ensure_hooks_path() {
  # AGENTS.md records that this gate had never once fired in the maintainer's own checkout, because
  # core.hooksPath was empty. Creating a tree is the natural moment to fix that, and .git/config is
  # shared by every worktree, so setting it once covers all of them.
  local cur
  cur="$($GIT config --get core.hooksPath || true)"
  if [ -z "$cur" ]; then
    $GIT config core.hooksPath .githooks
    note "  . enabled git hooks (core.hooksPath=.githooks, previously unset)"
  fi
}

install_deps() {
  local dest=$1
  [ -f "$dest/package-lock.json" ] || return 0
  note "  . npm ci (a fresh checkout has no node_modules, and pre-commit's local CI needs it)..."
  ( cd "$dest" && npm ci --prefer-offline --no-audit --no-fund ) >&2 \
    || die "npm ci failed -- the tree exists (${dest}); install dependencies there and carry on."
}

# -- worktree queries --------------------------------------------------------------------------
worktree_registered() { $GIT worktree list --porcelain | grep -qxF "worktree $1"; }

worktree_branch() {
  $GIT worktree list --porcelain | awk -v p="worktree $1" '
    $0 == p { found = 1; next }
    found && /^branch /  { sub(/^branch refs\/heads\//, ""); print; exit }
    found && /^$/ { exit }'
}

worktree_locked() {
  $GIT worktree list --porcelain | awk -v p="worktree $1" '
    $0 == p { found = 1; next }
    found && /^locked/ { print "yes"; exit }
    found && /^$/ { exit }'
}

is_dirty() { [ -n "$(git -C "$1" status --porcelain 2>/dev/null)" ]; }

has_unpushed() {
  local p=$1 base
  if git -C "$p" rev-parse --verify --quiet '@{upstream}' >/dev/null 2>&1; then
    [ "$(git -C "$p" rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo 1)" -gt 0 ]
  else
    base="origin/$(default_branch)"
    git -C "$p" rev-parse --verify --quiet "$base" >/dev/null 2>&1 || base="$(default_branch)"
    [ "$(git -C "$p" rev-list --count "$base..HEAD" 2>/dev/null || echo 1)" -gt 0 ]
  fi
}

dir_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1"; }

# Every registered worktree path except the main checkout itself.
all_worktree_paths() {
  $GIT worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r p; do
    [ "$p" = "$MAIN_ROOT" ] || printf '%s\n' "$p"
  done
}

# Only the ones that follow this convention.
list_worktree_paths() {
  all_worktree_paths | while IFS= read -r p; do
    case "$p" in "$WT_ROOT"/*) printf '%s\n' "$p" ;; esac
  done
}

# The ones that do not -- the whole reason `check` exists.
stray_worktree_paths() {
  all_worktree_paths | while IFS= read -r p; do
    case "$p" in "$WT_ROOT"/*) ;; *) printf '%s\n' "$p" ;; esac
  done
}

# -- new ---------------------------------------------------------------------------------------
cmd_new() {
  local slug='' issue='' type='feat' base='' install=1 offline=0 json=0
  # Mind `set -e`: `[ cond ] && x=1` returns 1 when the condition is false and the script exits
  # **silently**. Every conditional assignment in this file is written as if/fi on purpose.
  if [ "${WT_NO_INSTALL:-}" = '1' ]; then install=0; fi
  if [ "${WT_OFFLINE:-}" = '1' ]; then offline=1; fi
  while [ $# -gt 0 ]; do
    case "$1" in
      --issue) issue="${2:-}"; shift 2 ;;
      --type) type="${2:-}"; shift 2 ;;
      --base) base="${2:-}"; shift 2 ;;
      --no-install) install=0; shift ;;
      --offline) offline=1; shift ;;
      --json) json=1; shift ;;
      -*) die "unknown option: $1" ;;
      *) [ -z "$slug" ] || die "one slug only (extra: $1)"; slug="$1"; shift ;;
    esac
  done

  if [ -n "$issue" ]; then
    [ -z "$slug" ] || die "--issue and an explicit slug are mutually exclusive."
    command -v gh >/dev/null 2>&1 || die "--issue needs the gh CLI."
    local title
    title="$(gh issue view "$issue" --json title -q .title 2>/dev/null)" || die "cannot read issue #${issue}."
    slug="$type/$issue-$(slugify "$title")"
  fi
  [ -n "$slug" ] || { usage; exit 1; }
  validate_slug "$slug"

  local key path branch
  key="$(key_of "$slug")"; path="$WT_ROOT/$key"; branch="$slug"

  # Idempotent: an already-registered tree of the same name is returned as-is. Repeated agent calls
  # and resumed sessions both land here.
  if worktree_registered "$path"; then
    note "-> exists, reusing: $path"
    emit_result "$path" "$branch" "$key" "$json"; return 0
  fi
  [ ! -e "$path" ] || die "path exists but is not a registered worktree: ${path} (git worktree prune, or clear it by hand)"

  ensure_ignored
  mkdir -p "$WT_ROOT"

  local db; db="$(default_branch)"
  [ -n "$base" ] || base="origin/$db"
  if [ "$offline" -eq 0 ]; then
    note "-> fetch origin $db ..."
    $GIT fetch --quiet origin "$db" 2>/dev/null || note "  ! fetch failed, using the refs already present"
  fi
  $GIT rev-parse --verify --quiet "$base^{commit}" >/dev/null || base="$db"
  local sha
  sha="$($GIT rev-parse --verify "$base^{commit}")" || die "cannot resolve the baseline: $base"

  if $GIT show-ref --verify --quiet "refs/heads/$branch"; then
    local co
    co="$($GIT worktree list --porcelain | awk -v b="branch refs/heads/$branch" '
      /^worktree /{w=substr($0,10)} $0==b{print w; exit}')"
    [ -z "$co" ] || die "branch $branch is already checked out at $co -- one branch, one tree."
    note "-> branch $branch exists, attaching to it (its history is left alone)"
    $GIT worktree add "$path" "$branch" >&2
  else
    note "-> creating ${path} (branch ${branch}, baseline ${sha:0:12})"
    # Pinned to an immutable sha, never a moving ref like origin/main (see the file header).
    $GIT worktree add "$path" -b "$branch" "$sha" >&2
  fi

  ensure_hooks_path
  copy_includes "$path"
  if [ "$install" -eq 1 ]; then install_deps "$path"; fi

  note ""
  note "  ok. Work here:"
  note "      cd $path"
  note ""
  emit_result "$path" "$branch" "$key" "$json"
}

emit_result() {
  local path=$1 branch=$2 key=$3 json=$4
  if [ "$json" -eq 1 ]; then
    out "{\"path\":\"$path\",\"branch\":\"$branch\",\"key\":\"$key\"}"
  else
    out "$path" # stdout is the path alone: Claude Code's WorktreeCreate hook reads exactly this line
  fi
}

# -- check -------------------------------------------------------------------------------------
# The detector. A convention nothing measures is a convention that has already drifted: this repo
# ran for four days with five trees under .claude/worktrees/ and nothing said a word, because the
# rule lived in prose and the built-in EnterWorktree tool has its own hardcoded directory.
#
# Reports (and with --fix, relocates) any worktree of this repo outside .forge/worktrees/, plus the
# two environmental preconditions that make the convention hold at all.
cmd_check() {
  local fix=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --fix) fix=1; shift ;;
      *) die "unknown option: $1" ;;
    esac
  done

  local bad=0 p key target
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    key="$(basename "$p")"
    target="$WT_ROOT/$key"
    if [ "$fix" -eq 0 ]; then
      bad=1
      note "  x stray worktree: $p"
      note "      belongs at:  $target"
      continue
    fi
    if [ -e "$target" ]; then bad=1; note "  x cannot relocate $p -- $target already exists"; continue; fi
    if [ -n "$(worktree_locked "$p")" ]; then $GIT worktree unlock "$p" >/dev/null 2>&1 || true; fi
    mkdir -p "$WT_ROOT"
    if $GIT worktree move "$p" "$target" >&2; then
      note "  . moved $p -> $target"
    else
      bad=1; note "  x git worktree move failed for $p"
    fi
  done < <(stray_worktree_paths)

  # A tree under a non-ignored directory turns the entire checkout into untracked files, which is
  # how a stray tree gets committed by accident.
  if ! $GIT check-ignore -q .forge/probe 2>/dev/null; then
    bad=1
    note "  x .forge/ is not ignored -- worktree contents will show up as files to commit"
    note "      add '.forge/' to .gitignore (tools/wt.sh new also writes .git/info/exclude)"
  fi

  # An un-run clone has no pre-commit gate at all and says nothing about it (AGENTS.md).
  if [ -z "$($GIT config --get core.hooksPath || true)" ]; then
    bad=1
    note "  x core.hooksPath is unset -- the pre-commit gate never fires here (npm run hooks)"
  fi

  if [ "$bad" -ne 0 ]; then
    note ""
    note "  Fix the stray trees with:  tools/wt.sh check --fix"
    note ""
    return 1
  fi
  note "  ok every worktree is under ${WT_ROOT#"$MAIN_ROOT"/}, it is ignored, hooks are enabled"
  return 0
}

# -- list --------------------------------------------------------------------------------------
cmd_list() {
  local json=0
  if [ "${1:-}" = '--json' ]; then json=1; fi
  local first=1
  if [ "$json" -eq 1 ]; then printf '['; fi
  local p br dirty lock counts behind ahead
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    br="$(worktree_branch "$p")"; lock="$(worktree_locked "$p")"
    dirty=$(git -C "$p" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    counts="$(git -C "$p" rev-list --left-right --count "origin/$(default_branch)...HEAD" 2>/dev/null || printf '0\t0')"
    behind="$(printf '%s' "$counts" | cut -f1)"; ahead="$(printf '%s' "$counts" | cut -f2)"
    if [ "$json" -eq 1 ]; then
      [ "$first" -eq 1 ] || printf ','
      printf '{"path":"%s","branch":"%s","dirty":%s,"ahead":%s,"behind":%s,"locked":%s}' \
        "$p" "$br" "${dirty:-0}" "${ahead:-0}" "${behind:-0}" "$([ -n "$lock" ] && echo true || echo false)"
      first=0
    else
      out "$(printf '%-40s %-32s changed:%-4s +%-4s -%-4s %s' \
        "${p#"$WT_ROOT"/}" "$br" "${dirty:-0}" "${ahead:-0}" "${behind:-0}" "$([ -n "$lock" ] && echo '[locked]' || echo '')")"
    fi
  done < <(list_worktree_paths)
  if [ "$json" -eq 1 ]; then printf ']\n'; fi
  return 0
}

# -- rm ----------------------------------------------------------------------------------------
resolve_path_arg() {
  local a=$1
  case "$a" in
    /*) printf '%s\n' "$a" ;;
    *) printf '%s\n' "$WT_ROOT/$(key_of "$a")" ;;
  esac
}

cmd_rm() {
  local force=0 arg=''
  while [ $# -gt 0 ]; do
    case "$1" in
      --force|-f) force=1; shift ;;
      -*) die "unknown option: $1" ;;
      *) arg="$1"; shift ;;
    esac
  done
  [ -n "$arg" ] || { usage; exit 1; }
  local path; path="$(resolve_path_arg "$arg")"
  # Only trees under this convention may be removed: one typo must never reach the main checkout.
  case "$path" in "$WT_ROOT"/*) ;; *) die "refusing to remove a path outside $WT_ROOT: $path" ;; esac
  worktree_registered "$path" || die "not a registered worktree: $path"

  local br; br="$(worktree_branch "$path")"
  if [ "$force" -eq 0 ]; then
    ! is_dirty "$path" || die "$path has uncommitted changes. To discard them anyway: --force."
    ! has_unpushed "$path" || die "$path has unpushed commits (branch ${br}). Push first, or --force."
  fi

  if [ "$force" -eq 1 ]; then $GIT worktree remove --force "$path" >&2; else $GIT worktree remove "$path" >&2; fi
  if [ -n "$br" ]; then
    if [ "$force" -eq 1 ]; then $GIT branch -D "$br" >&2 2>/dev/null || true
    else $GIT branch -d "$br" >&2 2>/dev/null || note "  ! branch $br has unmerged commits, keeping it."; fi
  fi
  $GIT worktree prune
  note "  ok removed: $path"
}

# -- sweep -------------------------------------------------------------------------------------
# The same three refusals as planWorktreeSweep in src/util/worktree.ts: in use, too new, or holding
# work. Dry-run unless --yes.
cmd_sweep() {
  local days=7 yes=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --days) days="${2:-7}"; shift 2 ;;
      --yes|-y) yes=1; shift ;;
      *) die "unknown option: $1" ;;
    esac
  done
  local now cutoff p reason n=0
  now="$(date +%s)"; cutoff=$((days * 86400))
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    reason=''
    if [ -n "$(worktree_locked "$p")" ]; then reason='locked'
    elif is_dirty "$p"; then reason='uncommitted changes'
    elif has_unpushed "$p"; then reason='unpushed commits'
    elif [ $((now - $(dir_mtime "$p"))) -lt "$cutoff" ]; then reason="newer than ${days} days"
    fi
    if [ -n "$reason" ]; then
      note "  . keeping ${p#"$WT_ROOT"/} (${reason})"
    else
      n=$((n + 1))
      if [ "$yes" -eq 1 ]; then cmd_rm "$p"; else note "  . would remove ${p#"$WT_ROOT"/} (clean, merged, older than ${days} days)"; fi
    fi
  done < <(list_worktree_paths)
  if [ "$yes" -eq 0 ]; then
    note ""
    note "  (dry-run: ${n} tree(s) would be removed. Pass --yes to actually do it.)"
  fi
}

# -- doctor ------------------------------------------------------------------------------------
cmd_doctor() {
  local bad=0
  $GIT worktree prune
  $GIT worktree repair >/dev/null 2>&1 || true
  note "worktree root: $WT_ROOT"
  cmd_check || bad=1
  local p
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if [ -d "$p/node_modules" ]; then note "  ok ${p#"$WT_ROOT"/} has dependencies"; else note "  ! ${p#"$WT_ROOT"/} has no node_modules (run npm ci in it)"; fi
  done < <(list_worktree_paths)
  return "$bad"
}

# -- Claude Code hooks -------------------------------------------------------------------------
# WorktreeCreate: a JSON payload on stdin (worktree_name / worktree_path); **stdout must be the
# created path and nothing else**, and a non-zero exit fails the creation. That routes `claude -w`,
# "work in a worktree" and `isolation: worktree` subagents through this script, so the built-in
# .claude/worktrees/ convention stops being produced.
json_field() {
  local field=$1 payload=$2
  if command -v jq >/dev/null 2>&1; then printf '%s' "$payload" | jq -r ".$field // empty"; else
    printf '%s' "$payload" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j[process.argv[1]]??""))}catch{}})' "$field"
  fi
}

cmd_hook_create() {
  local payload name
  payload="$(cat)"
  name="$(json_field worktree_name "$payload")"
  [ -n "$name" ] || name="$(basename "$(json_field worktree_path "$payload")")"
  [ -n "$name" ] || die "WorktreeCreate payload carried neither worktree_name nor worktree_path."
  cmd_new "$name" # stdout is the path alone; everything human-facing went to stderr
}

cmd_hook_remove() {
  local payload path name
  payload="$(cat)"
  path="$(json_field worktree_path "$payload")"
  if [ -z "$path" ]; then
    name="$(json_field worktree_name "$payload")"
    [ -n "$name" ] || exit 0
    path="$WT_ROOT/$(key_of "$name")"
  fi
  case "$path" in "$WT_ROOT"/*) ;; *) exit 0 ;; esac # not ours: hand it back to Claude Code
  worktree_registered "$path" || exit 0
  # Claude Code already decided the tree may go, so force-remove the tree -- but delete the branch
  # **safely**: an unmerged branch stays. A tree can be recreated from a branch; a branch cannot.
  local br; br="$(worktree_branch "$path")"
  $GIT worktree remove --force "$path" >&2 2>/dev/null || true
  [ -z "$br" ] || $GIT branch -d "$br" >&2 2>/dev/null || true
  $GIT worktree prune
}

# -- dispatch ----------------------------------------------------------------------------------
case "${1:-}" in
  new) shift; cmd_new "$@" ;;
  list) shift; cmd_list "$@" ;;
  check) shift; cmd_check "$@" ;;
  rm|remove) shift; cmd_rm "$@" ;;
  sweep) shift; cmd_sweep "$@" ;;
  doctor) shift; cmd_doctor ;;
  path) shift; [ -n "${1:-}" ] || { usage; exit 1; }; validate_slug "$1"; out "$WT_ROOT/$(key_of "$1")" ;;
  hook-create) shift; cmd_hook_create ;;
  hook-remove) shift; cmd_hook_remove ;;
  ''|-h|--help|help) usage; [ -n "${1:-}" ] || exit 1 ;;
  *) die "unknown command: $1 (tools/wt.sh --help)" ;;
esac
