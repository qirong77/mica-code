#!/usr/bin/env bash
# usage: bench-run.sh <run-tag> <parallelism> <agents csv> <tasks csv>
#
# Runs the whole (agent x task) matrix with at most <parallelism> trials in
# flight.  Each cell is one `harbor run` invocation with its own job directory
# and its own task-scoped proxy URL, so every cell is independently re-runnable
# by (agent, task) id and the proxy log alone attributes tokens to one cell.
#
# Layout:
#   ~/mica-bench/runs/<tag>/<agent>__<task>.log     raw harbor output
#   ~/mica-bench/runs/<tag>/status.tsv              agent task rc reward wall status
set -uo pipefail

TAG="${1:?run tag}"
PAR="${2:?parallelism}"
AGENTS="${3:?agents csv}"
TASKS="${4:?tasks csv}"

OUT="$HOME/mica-bench/runs/$TAG"
mkdir -p "$OUT"
: > "$OUT/status.tsv"

IFS=',' read -r -a AGENT_ARR <<< "$AGENTS"
IFS=',' read -r -a TASK_ARR <<< "$TASKS"

PAIRS=()
for t in "${TASK_ARR[@]}"; do
  for a in "${AGENT_ARR[@]}"; do
    PAIRS+=("$a $t")
  done
done

echo "[bench] tag=$TAG parallelism=$PAR cells=${#PAIRS[@]}"
echo "[bench] agents: ${AGENT_ARR[*]}"
echo "[bench] tasks : ${TASK_ARR[*]}"

printf '%s\n' "${PAIRS[@]}" | xargs -P "$PAR" -n 2 bash "$HOME/mica-bench/cell.sh" "$TAG"

echo "[bench] all cells finished"
sort -k1,1 -k2,2 "$OUT/status.tsv"
