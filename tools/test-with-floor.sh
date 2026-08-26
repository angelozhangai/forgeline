#!/usr/bin/env bash
# Run the tests, and assert that the number of tests they report is not below the floor.
#
# Why this exists: `--test-force-exit` used to kill the node:test process before some test files had
# reported. The same commit run three times in a row reported 875 / 875 / 856 tests, and said `fail 0`
# **every time** -- a green light covering 19 tests that never ran at all. That is the worst kind of hole in
# a guardrail: the silent kind.
#
# The flag is gone (with it removed, five consecutive runs held steady at 875 and the process exited on its
# own). This floor is what stops it, or anything else that exits early and quietly runs fewer tests, from
# creeping back.
#
# Raise the floor whenever you add tests, exactly as you would the coverage floors behind test:cov:
# the floor is a **ratchet**. It only goes up, and lowering it has to be a deliberate change with the reason
# written down.
set -euo pipefail

FLOOR="${TEST_COUNT_FLOOR:-1211}"
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

set +e
"$@" 2>&1 | tee "$LOG"
status=${PIPESTATUS[0]}
set -e
[ "$status" -eq 0 ] || exit "$status"

# Take the last `ℹ tests N` line; the coverage report follows it and contains no such line.
count="$(grep -oE '^ℹ tests [0-9]+' "$LOG" | tail -1 | grep -oE '[0-9]+$' || true)"
if [ -z "$count" ]; then
  echo "✗ could not read the test count out of the output -- has the summary line changed format? A floor check that cannot run is no guardrail at all, so this counts as a failure." >&2
  exit 1
fi

if [ "$count" -lt "$FLOOR" ]; then
  # Always brace variables inside the heredoc. This bit once: `$FLOOR` followed immediately by a multi-byte
  # character made bash read the leading bytes of that character as part of the variable name, so `set -u`
  # killed the script before the message could print -- a guardrail that cannot report its own failure is no
  # guardrail. Work the difference out beforehand too, rather than doing arithmetic inside the heredoc.
  missing=$((FLOOR - count))
  cat >&2 <<MSG

✗ only ${count} tests were reported, which is below the floor of ${FLOOR}.

  Everything passed, but ${missing} fewer tests ran -- almost certainly a test file whose results never
  reported before the process exited (the historical culprit was --test-force-exit). Do **not** lower the
  floor to make this pass.
  First confirm every test file really ran. Only if tests were deliberately deleted should FLOOR come down,
  and then together with the reason.
MSG
  exit 1
fi

echo "✓ ${count} tests reported, at or above the floor of ${FLOOR}"
