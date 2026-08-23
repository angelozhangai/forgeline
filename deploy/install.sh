#!/bin/zsh
# Forge -- install or reinstall in one step: the resident daemon and the every-60s watchdog, as two
# LaunchAgents. It is idempotent and safe to run again.
# It replaces __SVC__ in the template plists with this repo's absolute path, which is what stops a new
# machine or a moved directory from breaking the install.
set -euo pipefail
DIR="${0:A:h}"          # <repo>/deploy
SVC="${DIR:h}"          # the repo root
LA="$HOME/Library/LaunchAgents"
U="$(id -u)"
mkdir -p "$LA" "$SVC/logs"

# Migration: clear out the old names (com.demo.review-svc*, since renamed to com.forge.*) so the two sets do
# not end up installed side by side.
for old in com.demo.review-svc com.demo.review-svc.watchdog; do
  launchctl bootout "gui/$U/$old" 2>/dev/null || true
  rm -f "$LA/$old.plist"
done

for label in com.forge.daemon com.forge.watchdog; do
  src="$DIR/$label.plist"
  dst="$LA/$label.plist"
  [ -f "$src" ] || { echo "✗ the template $src is missing"; exit 1; }
  sed "s#__SVC__#$SVC#g" "$src" > "$dst"
  launchctl bootout "gui/$U/$label" 2>/dev/null || true            # stop the old one first, if it is installed
  # bootout is asynchronous, so wait until it has fully unloaded -- otherwise the bootstrap right after it
  # hits "error 5: Input/output error".
  for _ in $(seq 1 25); do launchctl print "gui/$U/$label" >/dev/null 2>&1 || break; sleep 0.2; done
  launchctl bootstrap "gui/$U" "$dst" || { echo "✗ bootstrap $label failed (run ./deploy/uninstall.sh first, then try again)"; exit 1; }
  launchctl enable "gui/$U/$label" 2>/dev/null || true
  echo "✓ installed $label"
done

# The local CI gate as a git hook, matching the main repo's discipline.
git -C "$SVC" config core.hooksPath .githooks 2>/dev/null || true

PORT="${FORGE_HEALTH_PORT:-4319}"
echo ""
echo "✓ the Forge daemon and watchdog are installed and running."
echo "  status page: http://127.0.0.1:$PORT/"
echo "  logs:        tail -f $SVC/logs/launchd.log    (the daemon)"
echo "               tail -f $SVC/logs/watchdog.log   (the watchdog)"
launchctl list | grep forge || true
