#!/usr/bin/env bash
# 跑测试，并断言「汇报出来的用例总数不低于地板」。
#
# 为什么需要这个：`--test-force-exit` 曾经让 node:test 在部分测试文件汇报之前就杀掉进程。
# 同一份代码连跑三次得到 875 / 875 / 856 个用例，而且**三次都报 `fail 0`**——
# 绿灯掩盖了 19 个根本没跑的用例。这是护栏上最坏的一种洞：它不响。
#
# 那个 flag 已经拿掉（拿掉后 5 次连跑稳定 875，且进程能自己退出）。这条地板是防它、
# 或任何同类的「提前退出 → 静默少跑」悄悄回来。
#
# 加了新测试就把地板抬上去，用法与 test:cov 的覆盖率下限完全一致：
# 地板是**棘轮**，只许往上，往下调必须是一次有意的、写清楚理由的改动。
set -euo pipefail

FLOOR="${TEST_COUNT_FLOOR:-1165}"
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

set +e
"$@" 2>&1 | tee "$LOG"
status=${PIPESTATUS[0]}
set -e
[ "$status" -eq 0 ] || exit "$status"

# 取最后一行 `ℹ tests N`（覆盖率报告在后面，不含这个模式）。
count="$(grep -oE '^ℹ tests [0-9]+' "$LOG" | tail -1 | grep -oE '[0-9]+$' || true)"
if [ -z "$count" ]; then
  echo "✗ 没能从输出里读到用例总数——汇总行格式变了？地板检查失效等于没有护栏，故判失败。" >&2
  exit 1
fi

if [ "$count" -lt "$FLOOR" ]; then
  # heredoc 里的变量一律加花括号：`$FLOOR。` 后面紧跟中文标点时，bash 会把那个多字节
  # 字符的头几个字节也当成变量名的一部分，于是 set -u 抢在提示打印之前把脚本打死——
  # 护栏本身报不出错，等于没有护栏。差值也先算好，别在 heredoc 里做算术。
  missing=$((FLOOR - count))
  cat >&2 <<MSG

✗ 只汇报了 ${count} 个用例，低于地板 ${FLOOR}。

  测试全绿但少跑了 ${missing} 个 —— 几乎可以肯定是有测试文件在汇报前进程就退出了
  （历史坑：--test-force-exit）。**不要**为了让它过而调低地板。
  先确认所有测试文件都真的跑了；确实是有意删掉了测试，再连同理由一起下调 FLOOR。
MSG
  exit 1
fi

echo "✓ 用例数 $count ≥ 地板 $FLOOR"
