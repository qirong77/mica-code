#!/usr/bin/env bash
# usage: cell2.sh <run-tag> <agent> <task>
#
# Same contract as cell.sh (one cell -> one status.tsv row), plus one fix:
# a stall that happens *after* the agent phase is not retried.
#
# Rationale: when an agent burns its full 1 h budget and times out, the verifier
# sometimes wedges too.  Retrying the cell then costs another full agent budget
# to arrive at the same place, so ~1.7 h is spent for nothing.  A stall *during*
# the agent phase is still retried, because that is the opencode futex deadlock
# and a fresh attempt frequently succeeds.
#
# Kept as a separate file rather than edited in place: bash reads its script
# lazily by byte offset, so rewriting a script under a running instance corrupts
# that instance (it cost us two cells).  Consolidate back into cell.sh once the
# matrix has drained.
set -uo pipefail

TAG="$1"; AGENT="$2"; TASK="$3"

OUT="$HOME/mica-bench/runs/$TAG"
LOG="$OUT/${AGENT}__${TASK}.log"
JOBDIR="$HOME/mica-bench/harbor-jobs/${TAG}__${AGENT}__${TASK}"
mkdir -p "$OUT"

# shellcheck disable=SC1090
source "$HOME/mica-bench/env.sh"
export MICA_BENCH_RUN_TAG="$TAG"

STALL_SECS="${MICA_BENCH_STALL_SECS:-600}"    # agent-phase silence that means dead
SETUP_SECS="${MICA_BENCH_SETUP_SECS:-1800}"   # build/install may be quiet for longer
VERIFY_GRACE=3                                # verifier gets a multiple of STALL_SECS
MAX_ATTEMPTS="${MICA_BENCH_ATTEMPTS:-2}"
POLL=30

MIN_FREE_MB=8000
avail_mb=$(df -m /System/Volumes/Data 2>/dev/null | awk 'NR==2{print $4}')
if [ -n "${avail_mb:-}" ] && [ "$avail_mb" -lt "$MIN_FREE_MB" ]; then
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$AGENT" "$TASK" NA NA 0 skipped-lowdisk >> "$OUT/status.tsv"
  echo "[cell] SKIP ${AGENT}__${TASK}: host disk ${avail_mb}MB free (min ${MIN_FREE_MB}MB)"
  exit 0
fi

reclaim() {
  docker container prune -f >/dev/null 2>&1
  docker image prune -f  >/dev/null 2>&1
  # Each harbor trial leaves behind its built env image (e.g.
  # "music-harmony__abc123__env-main:latest", 0.4-2 GB a piece).  They are
  # tagged, so `image prune` alone never touches them and they accumulate until
  # the datadisk fills -- which is exactly how the first run died.
  docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
    | grep -E '__env-main:(latest|.*)$' \
    | xargs -r docker rmi -f >/dev/null 2>&1
  docker builder prune -f >/dev/null 2>&1
  # fstrim is what actually shrinks the sparse datadisk on the host; without it
  # the image file only ever grows.
  colima ssh -- sudo fstrim -v /var/lib/docker >/dev/null 2>&1
}

trial_dir()  { ls -d "$JOBDIR"/${TASK}__* 2>/dev/null | head -1; }
container_of() {
  local d; d=$(trial_dir)
  [ -n "$d" ] && echo "$(basename "$d")__env-main-1"
}
in_verifier() { ls "$JOBDIR"/${TASK}__*/verifier >/dev/null 2>&1; }
newest_mtime() {
  local m=0 t
  t=$(stat -f '%m' "$LOG" 2>/dev/null)
  [ -n "$t" ] && [ "$t" -gt "$m" ] && m=$t
  for t in $(find "$JOBDIR" -type f -exec stat -f '%m' {} \; 2>/dev/null); do
    [ "$t" -gt "$m" ] && m=$t
  done
  echo "$m"
}

STALLED=0
RETRYABLE=0
ATTEMPT_RC=0

run_attempt() {
  STALLED=0; RETRYABLE=0
  rm -rf "$JOBDIR"
  "$HOME/mica-bench/run-agent.sh" "$AGENT" "$TASK" >"$LOG" 2>&1 &
  local hpid=$! started idle limit nm cname cpu elapsed exec_started
  started=$(date +%s)

  while kill -0 "$hpid" 2>/dev/null; do
    sleep "$POLL"
    kill -0 "$hpid" 2>/dev/null || break

    nm=$(newest_mtime)
    idle=$(( $(date +%s) - ${nm:-0} ))
    elapsed=$(( $(date +%s) - started ))

    exec_started=0
    ls "$JOBDIR"/${TASK}__*/agent/*.txt >/dev/null 2>&1 && exec_started=1
    limit=$SETUP_SECS
    [ "$exec_started" = 1 ] && limit=$STALL_SECS
    in_verifier && limit=$(( STALL_SECS * VERIFY_GRACE ))

    [ "$idle" -gt "$limit" ] || continue

    cname=$(container_of); cpu=""
    [ -n "$cname" ] && cpu=$(docker stats --no-stream --format '{{.CPUPerc}}' "$cname" 2>/dev/null | tr -d '% ')
    # a container burning CPU is working (compiling, test suite), not stalled
    [ -n "$cpu" ] && [ "${cpu%%.*}" -ge 1 ] && continue

    # the agent already finished, so a re-run would repeat its whole budget
    if in_verifier; then RETRYABLE=0; else RETRYABLE=1; fi

    echo "[cell] STALL ${AGENT}__${TASK} idle=${idle}s limit=${limit}s cpu=${cpu:-none} elapsed=${elapsed}s retryable=${RETRYABLE}" | tee -a "$LOG"
    pkill -P "$hpid" 2>/dev/null
    kill -TERM "$hpid" 2>/dev/null; sleep 3; kill -KILL "$hpid" 2>/dev/null
    [ -n "$cname" ] && docker rm -f "$cname" >/dev/null 2>&1
    STALLED=1
    break
  done

  wait "$hpid" 2>/dev/null
  ATTEMPT_RC=$?
}

start=$(date +%s)
attempt=1
while : ; do
  run_attempt
  [ "$STALLED" = 1 ] || break
  if [ "$RETRYABLE" = 0 ]; then
    echo "[cell] NO-RETRY ${AGENT}__${TASK}: stalled after the agent phase" | tee -a "$LOG"
    break
  fi
  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "[cell] GIVE UP ${AGENT}__${TASK} after ${MAX_ATTEMPTS} stalled attempt(s)" | tee -a "$LOG"
    break
  fi
  attempt=$((attempt + 1))
  echo "[cell] RETRY ${AGENT}__${TASK} attempt=${attempt}" | tee -a "$LOG"
done
end=$(date +%s)

reward=$(find "$JOBDIR" -name reward.txt -exec cat {} \; 2>/dev/null | head -1 | tr -d '\n')
exc=$(find "$JOBDIR" -name exception.txt 2>/dev/null | head -1)

if [ "$STALLED" = 1 ]; then
  status="stalled"
elif [ ! -d "$JOBDIR" ] || [ "${ATTEMPT_RC:-0}" -ne 0 ]; then
  status="failed"
elif [ -n "$exc" ]; then
  status="exception"
elif [ -z "$reward" ]; then
  status="exception"
else
  status="ok"
fi

reclaim

printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$AGENT" "$TASK" "$ATTEMPT_RC" "${reward:-NA}" "$((end - start))" "$status" >> "$OUT/status.tsv"
echo "[cell] ${AGENT}__${TASK} rc=$ATTEMPT_RC reward=${reward:-NA} status=$status $((end - start))s"
