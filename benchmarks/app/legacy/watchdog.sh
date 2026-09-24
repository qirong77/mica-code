#!/usr/bin/env bash
# Emergency disk watchdog.  The colima VM's disk image lives on the host, so a
# full host disk makes the VM's I/O fail mid-trial (that cost us a whole run).
# cell.sh already trims after every cell, but a single long trial can run for an
# hour without trimming, so reap in the background too.
LOG="$HOME/mica-bench/watchdog.log"
while true; do
  avail_mb=$(df -m /System/Volumes/Data 2>/dev/null | awk 'NR==2{print $4}')
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  if [ -n "${avail_mb:-}" ] && [ "$avail_mb" -lt 9000 ]; then
    echo "$ts LOW ${avail_mb}MB -> reclaiming" >> "$LOG"
    docker container prune -f >> "$LOG" 2>&1
    docker image prune -f     >> "$LOG" 2>&1
    docker builder prune -f   >> "$LOG" 2>&1
    docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
      | grep -E '__env-main:' | xargs -r docker rmi -f >> "$LOG" 2>&1
    colima ssh -- sudo fstrim -v /var/lib/docker >> "$LOG" 2>&1
    df -m /System/Volumes/Data | tail -1 >> "$LOG"
  fi
  sleep 300
done
