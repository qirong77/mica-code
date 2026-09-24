#!/usr/bin/env bash
# Launch all four agents against the same quick task, in parallel.
set -uo pipefail

source "$HOME/mica-bench/env.sh"

rm -f "$HOME/mica-bench/events.jsonl"
for a in mica codex opencode kimi-code; do
  rm -rf "$HOME/mica-bench/harbor-jobs/qc2-$a"
done

pids=()
for a in mica codex opencode kimi-code; do
  "$HOME/mica-bench/run-agent.sh" "$a" "qc2-$a" --include-task-name quick-task \
    > "/tmp/qc2-$a.log" 2>&1 &
  pids+=($!)
done

echo "launched pids: ${pids[*]}"
for p in "${pids[@]}"; do wait "$p"; done
echo "ALL AGENTS FINISHED"
