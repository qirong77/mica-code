#!/usr/bin/env bash
# Disk watchdog v2.
#
# The colima VM's datadisk is a sparse file on the host, so the host's free
# space is the number that matters (the VM can report 40 % while the host is at
# 99 %, and then the VM's I/O dies mid-trial -- that cost us a whole run).
#
# The important change over v1: trim *every* tick, not only when the disk looks
# low.  Deleting layers inside the VM frees blocks internally but the sparse
# file on the host only shrinks when the guest issues TRIM, and during a matrix
# of 1 h cells the per-cell trim in cell.sh runs far too rarely -- the host was
# losing ~10 GB per 25 min.  A trim measured 13 GB reclaimed while five trials
# were running, so it is safe to do concurrently and it is the whole fix.
set -uo pipefail

LOG="$HOME/mica-bench/watchdog.log"
TICK="${MICA_BENCH_WATCHDOG_TICK:-120}"
LOW_MB="${MICA_BENCH_WATCHDOG_LOW_MB:-12000}"

trim() { colima ssh -- sudo fstrim -v /var/lib/docker >/dev/null 2>&1; }

while true; do
  avail_mb=$(df -m /System/Volumes/Data 2>/dev/null | awk 'NR==2{print $4}')
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  if [ -n "${avail_mb:-}" ] && [ "$avail_mb" -lt "$LOW_MB" ]; then
    echo "$ts LOW ${avail_mb}MB -> reclaiming" >>"$LOG"
    docker container prune -f >>"$LOG" 2>&1
    docker image prune -f     >>"$LOG" 2>&1
    docker builder prune -f   >>"$LOG" 2>&1
    # Images of *running* containers cannot be removed (docker refuses), so this
    # only clears trials that already ended -- the trim below does the real work.
    docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
      | grep -E '__env-main:' | xargs -r docker rmi -f >>"$LOG" 2>&1
  fi
  trim
  avail_after=$(df -m /System/Volumes/Data 2>/dev/null | awk 'NR==2{print $4}')
  if [ -n "${avail_mb:-}" ] && [ -n "${avail_after:-}" ] \
     && [ "$((avail_after - avail_mb))" -gt 512 ]; then
    echo "$ts trim recovered ${avail_mb}MB -> ${avail_after}MB" >>"$LOG"
  fi
  sleep "$TICK"
done
