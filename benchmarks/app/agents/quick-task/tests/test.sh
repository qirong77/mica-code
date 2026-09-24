#!/usr/bin/env bash
# Verifier contract: write /logs/verifier/reward.txt (exit code is informational).
set -uo pipefail

REWARD_FILE="/logs/verifier/reward.txt"
mkdir -p "$(dirname "$REWARD_FILE")"

if [ ! -f /app/greeting.txt ]; then
    echo "FAIL: /app/greeting.txt does not exist"
    echo 0 > "$REWARD_FILE"
    exit 0
fi

actual="$(cat /app/greeting.txt)"
if [ "$actual" = "hello bench" ]; then
    echo "PASS: content matches"
    echo 1 > "$REWARD_FILE"
else
    echo "FAIL: content mismatch"
    echo "expected: 'hello bench'"
    echo "actual:   '$actual'"
    echo 0 > "$REWARD_FILE"
fi
exit 0
