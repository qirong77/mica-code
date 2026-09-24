#!/usr/bin/env bash
# usage: cell.sh <run-tag> <agent> <task>
#
# One benchmark cell = one (agent, task) trial.  Invoked by bench-run.sh so the
# parallelism lives in xargs and this stays a plain sequential unit.
#
# Emits one row to $OUT/status.tsv:
#   agent <TAB> task <TAB> rc <TAB> reward <TAB> duration_s <TAB> status
# status is one of ok | exception | failed | stalled | skipped-lowdisk:
#   ok               harbor finished and wrote a reward file
#   exception        harbor finished but the trial recorded an exception (no reward)
#   failed           harbor never produced a job dir / non-zero exit (infra error)
#   stalled          agent stopped making progress and was killed (see below)
#   skipped-lowdisk  refused to start because the host disk was critically low
#
# ---------------------------------------------------------------------------
# Stall detection
#
# TB's prebuilt images are amd64-only, so every agent binary runs under Rosetta
# (the VM's kernel is aarch64 and Rosetta translates, but an amd64 userland has
# no aarch64 loader, so arm64 binaries cannot be used as a workaround).  Bun
# binaries under Rosetta occasionally deadlock -- we have caught opencode parked
# in `futex_wait_queue` at 0% CPU, with no child process, indefinitely.  Such a
# cell would otherwise sit until the 1 h agent timeout, wasting a whole slot.
#
# So each attempt is polled: if nothing in the job dir has been written for
# STALL_SECS *and* the cell's container is below 1% CPU, the attempt is killed
# and retried.  Liveness comes from file mtimes because a healthy agent rewrites
# its transcript (`agent/<name>.txt`) on every step.
# ---------------------------------------------------------------------------
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

# Host disk is the scarce resource: the colima disk image lives on it, and when
# it fills the VM's I/O dies mid-trial (we lost a whole run to this).  Refuse to
# start rather than corrupt another trial, and reclaim after every cell.
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
# newest mtime (epoch seconds) across the cell log and the job dir
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

run_attempt() {
  STALLED=0
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

    # execution has begun once the agent transcript exists; the verifier only
    # starts after it, so a present verifier/ dir means the trial is wrapping up
    # and a quiet spell there is normal (it can run for many minutes).
    exec_started=0
    ls "$JOBDIR"/${TASK}__*/agent/*.txt >/dev/null 2>&1 && exec_started=1
    limit=$SETUP_SECS
    [ "$exec_started" = 1 ] && limit=$STALL_SECS
    ls "$JOBDIR"/${TASK}__*/verifier >/dev/null 2>&1 && limit=$(( STALL_SECS * VERIFY_GRACE ))

    [ "$idle" -gt "$limit" ] || continue

    cname=$(container_of); cpu=""
    [ -n "$cname" ] && cpu=$(docker stats --no-stream --format '{{.CPUPerc}}' "$cname" 2>/dev/null | tr -d '% ')
    # a container burning CPU is working (compiling, test suite), not stalled
    [ -n "$cpu" ] && [ "${cpu%%.*}" -ge 1 ] && continue

    echo "[cell] STALL ${AGENT}__${TASK} idle=${idle}s limit=${limit}s cpu=${cpu:-none} elapsed=${elapsed}s" | tee -a "$LOG"
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
ATTEMPT_RC=0
attempt=1
while : ; do
  run_attempt
  [ "$STALLED" = 1 ] || break
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

if [ "$STALLED" = 1 ] && [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
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
