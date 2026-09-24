#!/usr/bin/env bash
# usage: bench-run4.sh <run-tag> <parallelism> <agents csv> <tasks csv>
#
# Matrix runner, same recovery properties as bench-run3.sh (idempotent, safe to
# restart, skips done + in-flight cells) but it picks the next cell by
# LOAD-BALANCING across agents instead of in list order.
#
# Why: with task-major ordering, re-queueing one agent's cells (e.g. after
# changing its config) makes the scheduler run four cells of that single agent
# concurrently.  On a 6-core VM that starves each of CPU and would inflate that
# agent's timeouts, which is a scoring bias, not a measurement of the agent.
# Here each launch goes to the agent with the fewest cells already in flight.
set -uo pipefail

TAG="${1:?run tag}"
PAR="${2:?parallelism}"
AGENTS="${3:?agents csv}"
TASKS="${4:?tasks csv}"

OUT="$HOME/mica-bench/runs/$TAG"
JOBS="$HOME/mica-bench/harbor-jobs"
mkdir -p "$OUT"

cell_done() {   # harbor produced a verdict -> the cell is finished
  local d="$JOBS/${TAG}__${1}__${2}"
  [ -n "$(find "$d" -name reward.txt -o -name exception.txt 2>/dev/null | head -1)" ]
}
cell_running() {
  pgrep -f "cell[0-9]*\.sh ${TAG} ${1} ${2}\$" >/dev/null 2>&1
}
agent_load() {  # cells of this agent currently in flight
  pgrep -f "cell[0-9]*\.sh ${TAG} ${1} " 2>/dev/null | wc -l | tr -d ' '
}
total_load() {
  pgrep -f "cell[0-9]*\.sh ${TAG} " 2>/dev/null | wc -l | tr -d ' '
}

IFS=',' read -r -a A <<< "$AGENTS"
IFS=',' read -r -a T <<< "$TASKS"

PENDING=()
skipped_run=0; skipped_done=0
for t in "${T[@]}"; do
  for a in "${A[@]}"; do
    if cell_running "$a" "$t"; then skipped_run=$((skipped_run+1)); continue; fi
    if cell_done    "$a" "$t"; then skipped_done=$((skipped_done+1)); continue; fi
    PENDING+=("$a $t")
  done
done

echo "[bench4] tag=$TAG par=$PAR pending=${#PENDING[@]} already-running=$skipped_run done=$skipped_done"
if [ "${#PENDING[@]}" -eq 0 ]; then
  echo "[bench4] nothing to do"
  exit 0
fi

while [ "${#PENDING[@]}" -gt 0 ]; do
  running=$(total_load)
  # a live process count can lag a launch by a moment; re-read until it settles
  while [ "${running:-0}" -lt "$PAR" ] && [ "${#PENDING[@]}" -gt 0 ]; do
    declare -A LOAD=()
    for a in "${A[@]}"; do LOAD[$a]=$(agent_load "$a"); done

    best=-1; bestload=999999; i=0
    for pair in "${PENDING[@]}"; do
      a="${pair%% *}"
      if [ "${LOAD[$a]}" -lt "$bestload" ]; then bestload="${LOAD[$a]}"; best=$i; fi
      i=$((i+1))
    done
    [ "$best" -lt 0 ] && break

    pair="${PENDING[$best]}"
    PENDING=("${PENDING[@]:0:$best}" "${PENDING[@]:$((best+1))}")
    echo "[bench4] launch $pair (in-flight=$running agent-load=$bestload)"
    bash "$HOME/mica-bench/cell2.sh" "$TAG" $pair >>"$OUT/scheduler.log" 2>&1 &
    running=$((running+1))
    sleep 2
  done
  sleep 20
done

wait
echo "[bench4] all cells finished"
