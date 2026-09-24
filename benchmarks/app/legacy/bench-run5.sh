#!/usr/bin/env bash
# usage: bench-run5.sh <run-tag> <parallelism> <agents csv> <tasks csv>
#
# Matrix runner: idempotent and safe to restart (skips cells that already have a
# verdict, skips cells already in flight), and it picks the next cell by
# balancing load ACROSS agents so no single agent hogs the machine.
#
# Three deliberate properties:
#
#   1. bash 3.2 safe -- macOS ships bash 3.2.57, which has no associative
#      arrays.  bench-run4.sh used `declare -A` and silently collapsed every
#      agent into one array slot, so it kept re-picking the same cell and
#      launched one cell three times (the three copies then fought over the
#      same job directory).  Everything here is arrays + loops only.
#   2. per-agent cap -- a single agent may hold at most ceil(PAR/agents) slots.
#      Running 4 cells of one agent on a 6-core VM starves each of CPU, which
#      inflates that agent's timeouts: a scoring bias, not a measurement.
#   3. pre-launch dedupe guard -- `cell_running` is re-checked immediately
#      before spawning, so no bug in the picker can ever double-launch a cell.
#
# DRYRUN=1 simulates the scheduler against a counter file instead of real
# processes, so the dispatch policy can be verified without touching the VM.
set -uo pipefail

TAG="${1:?run tag}"
PAR="${2:?parallelism}"
AGENTS="${3:?agents csv}"
TASKS="${4:?tasks csv}"
DRYRUN="${DRYRUN:-0}"

OUT="$HOME/mica-bench/runs/$TAG"
JOBS="$HOME/mica-bench/harbor-jobs"
mkdir -p "$OUT"

IFS=',' read -r -a A <<< "$AGENTS"
IFS=',' read -r -a T <<< "$TASKS"
N_AGENTS=${#A[@]}
# ceil(PAR / agents): 5 slots over 4 agents -> 2
MAX_AGENT=$(( (PAR + N_AGENTS - 1) / N_AGENTS ))
[ "$MAX_AGENT" -lt 1 ] && MAX_AGENT=1

cell_done() {   # harbor produced a verdict -> the cell is finished
  local d="$JOBS/${TAG}__${1}__${2}"
  [ -n "$(find "$d" -name reward.txt -o -name exception.txt 2>/dev/null | head -1)" ]
}
cell_running() {
  pgrep -f "cell[0-9]*\.sh ${TAG} ${1} ${2}\$" >/dev/null 2>&1
}
agent_load() {
  pgrep -f "cell[0-9]*\.sh ${TAG} ${1} " 2>/dev/null | wc -l | tr -d ' '
}
total_load() {
  pgrep -f "cell[0-9]*\.sh ${TAG} " 2>/dev/null | wc -l | tr -d ' '
}

# --- dry-run shims: pretend-load from a counter file, never spawn -------------
SIM="$OUT/.sim-load"
sim_load() {
  local v
  v=$(grep "^${1}=" "$SIM" 2>/dev/null | head -1 | cut -d= -f2)
  echo "${v:-0}"
}
sim_inc() {
  local cur; cur=$(sim_load "$1")
  grep -v "^${1}=" "$SIM" 2>/dev/null > "$SIM.tmp" || true
  echo "${1}=$((cur+1))" >> "$SIM.tmp"; mv "$SIM.tmp" "$SIM"
}
if [ "$DRYRUN" = "1" ]; then
  : > "$SIM"
  agent_load() { sim_load "$1"; }
  total_load() { local n=0 v; for a in "${A[@]}"; do v=$(sim_load "$a"); n=$((n+v)); done; echo "$n"; }
  cell_running() { return 1; }
fi

PENDING=()
skipped_run=0; skipped_done=0
for t in "${T[@]}"; do
  for a in "${A[@]}"; do
    if cell_running "$a" "$t"; then skipped_run=$((skipped_run+1)); continue; fi
    if cell_done    "$a" "$t"; then skipped_done=$((skipped_done+1)); continue; fi
    PENDING+=("$a $t")
  done
done

echo "[bench5] tag=$TAG par=$PAR max-per-agent=$MAX_AGENT pending=${#PENDING[@]} running=$skipped_run done=$skipped_done dryrun=$DRYRUN"
if [ "${#PENDING[@]}" -eq 0 ]; then
  echo "[bench5] nothing to do"
  exit 0
fi

while [ "${#PENDING[@]}" -gt 0 ]; do
  running=$(total_load)
  while [ "$running" -lt "$PAR" ] && [ "${#PENDING[@]}" -gt 0 ]; do
    # pick among pending cells the one whose agent is least loaded
    best=-1; bestload=999999; i=0
    for pair in "${PENDING[@]}"; do
      a="${pair%% *}"
      load=$(agent_load "$a")
      if [ "$load" -lt "$MAX_AGENT" ] && [ "$load" -lt "$bestload" ]; then
        bestload="$load"; best=$i
      fi
      i=$((i+1))
    done
    # every agent at its cap -> wait for a slot rather than over-subscribing
    if [ "$best" -lt 0 ]; then break; fi

    pair="${PENDING[$best]}"
    a="${pair%% *}"
    if ! cell_running "$a" "${pair##* }"; then
      PENDING=("${PENDING[@]:0:$best}" "${PENDING[@]:$((best+1))}")
      echo "[bench5] launch $pair (in-flight=$running agent-load=$bestload)"
      if [ "$DRYRUN" = "1" ]; then
        sim_inc "$a"
      else
        bash "$HOME/mica-bench/cell2.sh" "$TAG" $pair >>"$OUT/scheduler.log" 2>&1 &
      fi
      running=$((running+1))
      sleep 2
    else
      PENDING=("${PENDING[@]:0:$best}" "${PENDING[@]:$((best+1))}")
    fi
  done
  sleep 20
done

wait
echo "[bench5] all cells finished"
