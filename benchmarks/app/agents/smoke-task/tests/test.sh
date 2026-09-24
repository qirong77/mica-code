#!/bin/bash
# Verifier: reward 1 only when /app/greeting.txt matches byte-for-byte.
mkdir -p /logs/verifier

expected="hello from mica"
if [ -f /app/greeting.txt ] && [ "$(cat /app/greeting.txt)" = "$expected" ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
  echo "greeting.txt mismatch or missing" >&2
  cat /app/greeting.txt 2>/dev/null >&2 || true
fi
