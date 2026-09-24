#!/usr/bin/env bash
# usage: bench-run2.sh <run-tag> <parallelism> <agents csv> <tasks csv>
#
# Idempotent matrix runner.  Unlike bench-run.sh (a one-shot `xargs -P`), this
# one is safe to restart at any time and safe to run twice:
#
#   * cells that already produced a result are skipped
#   * cells that are currently running are skipped
#   * the parallelism limit is global for the tag, counted from live processes,
#     so a restart tops the run back up to PAR even if it was mid-flight
#
# That last property is what makes recovery trivial: if the scheduler itself
# wedges or dies, start it again and it fills the free slots without duplicating
# work.
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
  pgrep -f "cell\.sh ${TAG} ${1} ${2}$" >/dev/null 2>&1
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

echo "[bench2] tag=$TAG par=$PAR pending=${#PENDING[@]} already-running=$skipped_run done=$skipped_done"
if [ "${#PENDING[@]}" -eq 0 ]; then
  echo "[bench2] nothing to do"
  exit 0
fi

while [ "${#PENDING[@]}" -gt 0 ]; do
  running=$(pgrep -f "cell\.sh ${TAG} " 2>/dev/null | wc -l | tr -d ' ')
  while [ "${running:-0}" -lt "$PAR" ] && [ "${#PENDING[@]}" -gt 0 ]; do
    pair="${PENDING[0]}"
    PENDING=("${PENDING[@]:1}")
    echo "[bench2] launch $pair (in-flight=$running)"
    bash "$HOME/mica-bench/cell.sh" "$TAG" $pair >>"$OUT/scheduler.log" 2>&1 &
    running=$((running+1))
  done
  sleep 20
done

wait
echo "[bench2] all cells finished"
