#!/bin/zsh
# Forge bootstrap: take a new Mac from a fresh clone to a running daemon. Idempotent, and safe to run again.
# It automates every mechanical step -- node, npm, scaffolding the config, the git hooks, checking the main
# repo, and the doctor preflight. The parts that cannot be automated -- the secrets, logging the CLIs in, and
# the IM developer console -- stop at a checkpoint where doctor lists what is missing, for you to fill in
# before running it again. The script never enters a secret on your behalf.
#
# Usage:
#   ./deploy/bootstrap.sh            the mechanical setup plus the doctor preflight; all green, it tells you
#                                    the next step. It installs nothing and spends nothing.
#   ./deploy/bootstrap.sh --install  if the preflight is green, go on to ./deploy/install.sh and verify it --
#                                    the whole way in one step.
set -euo pipefail

DIR="${0:A:h}"          # <repo>/deploy
SVC="${DIR:h}"          # the repo root
cd "$SVC"

INSTALL=0
if [[ "${1:-}" == "--install" ]]; then INSTALL=1; fi

step(){ print -P "%F{cyan}▸ $1%f"; }
ok(){   print -P "%F{green}✓ $1%f"; }
warn(){ print -P "%F{yellow}⚠ $1%f"; }
die(){  print -P "%F{red}✗ $1%f"; exit 1; }

# 0) macOS only (launchd)
[[ "$(uname)" == "Darwin" ]] || die "this script supports macOS (launchd) only. Linux and Docker are not supported yet."

# 1) node ≥ 24
step "checking for node >= 24"
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then warn "node is not installed -> brew install node"; brew install node; else die "node is not installed and there is no Homebrew. Install Node >= 24 (https://nodejs.org) and run this again."; fi
fi
NODE_MAJ="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJ >= 24 )) || die "node is too old (>= 24 required, this is $NODE_MAJ). Upgrade it and run this again."
ok "node $(node -v)"

# 2) The target project, example-project: the live source of the mechanical actions and scripts. It is either
#    a sibling directory or wherever FORGE_PROJECT_ROOT points.
step "checking for the target project, example-project"
SIBLING="${SVC:h}/example-project"
ROOT="${FORGE_PROJECT_ROOT:-$SIBLING}"
if [[ ! -d "$ROOT/.git" ]]; then
  warn "the main repo was not found at $ROOT -- it is the live source of the mechanical actions, the scripts and the conventions."
  print "  clone it: git clone git@github.com:your-org/example-project.git \"$ROOT\""
  if [[ -t 0 ]] && read -q "REPLY?  clone it into the sibling directory now? [y/N] "; then
    echo; git clone git@github.com:your-org/example-project.git "$ROOT" || die "the clone failed (check your SSH key and gh permissions)"
  else
    echo; die "the target project is missing -- clone it and run this again, or point FORGE_PROJECT_ROOT at an existing checkout."
  fi
fi
ok "main repo at $ROOT"

# 3) npm install (pure JavaScript dependencies: yaml, zod and the IM SDK)
step "npm install"
npm install --no-audit --no-fund
ok "dependencies are in place"

# 4) Scaffold the config, never overwriting anything already filled in
step "scaffolding the config"
for f in forge.env weekly-overrides.tsv; do
  if [[ -f "config/$f" ]]; then ok "config/$f already exists, and is left alone";
  elif [[ -f "config/$f.example" ]]; then cp "config/$f.example" "config/$f"; warn "created config/$f from the .example -- fill in the secrets and the webhook"; fi
done

# 5) The git hooks (the local CI gate before a commit)
if git config core.hooksPath .githooks 2>/dev/null; then ok "git hooks enabled (pre-commit runs npm run ci)"; fi

# 6) The doctor preflight: the mechanical parts are done, and this reports whatever is left that cannot be
#    automated
step "./forge doctor preflight"
DOCTOR_OK=1
./forge doctor || DOCTOR_OK=0

echo
if (( DOCTOR_OK )); then
  ok "preflight all green -- ready to deploy."
  if (( INSTALL )); then
    warn "once the daemon starts it runs the gates and the daily contract probe on its own, which spends money automatically."
    step "installing and starting the daemon (./deploy/install.sh)"
    ./deploy/install.sh
    step "verifying"
    sleep 3
    ./forge health || true
    echo
    ok "deployed. Status page: http://127.0.0.1:${FORGE_HEALTH_PORT:-4319}/  |  logs: tail -f logs/launchd.log"
  else
    print -P "Next: %F{cyan}./deploy/install.sh%f to install the daemon and watchdog, or run %F{cyan}./deploy/bootstrap.sh --install%f to do the whole thing in one step."
  fi
else
  warn "the preflight found gaps (see doctor's ✗ marks above). These are the parts that cannot be automated and need you:"
  print "  1) fill in config/forge.env: the bot credentials, the direct-message target, and the result webhook (the file's own comments explain each)"
  print "  2) log the CLIs in: claude (and stay logged in), codex, and gh auth login"
  print "  3) in the IM developer console: set event subscription to the long connection, grant the permissions, and add the bot to the watched chats (see section 3 of deploy/README.md)"
  print "  4) the main repo's three code repos are not cloned -- run ./scripts/bootstrap.sh there"
  print -P "Once those are filled in, run %F{cyan}./deploy/bootstrap.sh%f again -- it is idempotent. If you accept the degraded mode, with no IM provider, you can also run %F{cyan}./deploy/install.sh%f directly."
  print -P "Want to be walked through it step by step? Have Claude Code or Codex run the %F{cyan}/deploy-forge%f skill, which is the blocking install guide."
  exit 2
fi
