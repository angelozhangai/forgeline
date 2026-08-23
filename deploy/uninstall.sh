#!/bin/zsh
# Forge -- stop and uninstall the daemon and watchdog LaunchAgents. The data in state/ and the logs in logs/
# are left alone.
# It also clears out the old com.demo.review-svc* names left over from before the rename.
set -uo pipefail
LA="$HOME/Library/LaunchAgents"
U="$(id -u)"
for label in com.forge.watchdog com.forge.daemon com.demo.review-svc.watchdog com.demo.review-svc; do
  launchctl bootout "gui/$U/$label" 2>/dev/null || true
  rm -f "$LA/$label.plist"
done
echo "✓ the Forge daemon and watchdog are stopped and uninstalled (state/ and logs/ are kept)"
