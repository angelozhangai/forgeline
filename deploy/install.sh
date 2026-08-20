#!/bin/zsh
# Forge — 一键安装/重装：守护(常驻) + 看门狗(每60s) 两个 LaunchAgent。幂等：可重复跑。
# 把模板 plist 里的 __SVC__ 替换为本仓绝对路径 → 解决「换机/换路径即坏」。
set -euo pipefail
DIR="${0:A:h}"          # <repo>/deploy
SVC="${DIR:h}"          # 仓根
LA="$HOME/Library/LaunchAgents"
U="$(id -u)"
mkdir -p "$LA" "$SVC/logs"

# 迁移：清掉旧名（com.demo.review-svc* → 现已更名 com.forge.*），避免新旧两套并存。
for old in com.demo.review-svc com.demo.review-svc.watchdog; do
  launchctl bootout "gui/$U/$old" 2>/dev/null || true
  rm -f "$LA/$old.plist"
done

for label in com.forge.daemon com.forge.watchdog; do
  src="$DIR/$label.plist"
  dst="$LA/$label.plist"
  [ -f "$src" ] || { echo "✗ 缺模板 $src"; exit 1; }
  sed "s#__SVC__#$SVC#g" "$src" > "$dst"
  launchctl bootout "gui/$U/$label" 2>/dev/null || true            # 先停旧（若已装）
  # bootout 是异步的：等它彻底卸载，否则紧跟的 bootstrap 会撞「error 5: Input/output error」
  for _ in $(seq 1 25); do launchctl print "gui/$U/$label" >/dev/null 2>&1 || break; sleep 0.2; done
  launchctl bootstrap "gui/$U" "$dst" || { echo "✗ bootstrap $label 失败（先 ./deploy/uninstall.sh 再重试）"; exit 1; }
  launchctl enable "gui/$U/$label" 2>/dev/null || true
  echo "✓ 已装 $label"
done

# 本地 CI 闸口 git hook（与主仓纪律一致）
git -C "$SVC" config core.hooksPath .githooks 2>/dev/null || true

PORT="${FORGE_HEALTH_PORT:-4319}"
echo ""
echo "✓ Forge 守护 + 看门狗已安装并启动。"
echo "  状态页： http://127.0.0.1:$PORT/"
echo "  日志：   tail -f $SVC/logs/launchd.log    （守护）"
echo "          tail -f $SVC/logs/watchdog.log   （看门狗）"
launchctl list | grep forge || true
