#!/bin/zsh
# Forge — 停并卸载守护 + 看门狗 LaunchAgent。数据(state/)、日志(logs/)保留。
# 一并清理旧名 com.demo.review-svc*（更名前的遗留）。
set -uo pipefail
LA="$HOME/Library/LaunchAgents"
U="$(id -u)"
for label in com.forge.watchdog com.forge.daemon com.demo.review-svc.watchdog com.demo.review-svc; do
  launchctl bootout "gui/$U/$label" 2>/dev/null || true
  rm -f "$LA/$label.plist"
done
echo "✓ 已停并卸载 Forge 守护 + 看门狗（state/ 数据与 logs/ 日志保留）"
