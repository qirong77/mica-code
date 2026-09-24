#!/usr/bin/env python3
"""
dashboard.py -- local, read-only web dashboard for a running mica-bench agent matrix.

Zero third-party dependencies (Python stdlib only), offline-safe (no CDN, no
external fonts, no JS libraries, no charting lib), binds 127.0.0.1 by default.

    python3 /Users/qironglin/mica-bench/dashboard/dashboard.py
    open http://127.0.0.1:8790/

Read-only by construction: it opens files for reading, lists directories, and
shells out to `ps` (read-only).  It never writes anything outside its own
process memory and never touches a running cell, container or the proxy.

API
---
GET /            the page (one embedded HTML document)
GET /api/data    the JSON payload the page polls every 5s
GET /health      {"ok": true, "pid": ...}

Attribution rule (the one thing that is easy to get wrong): the proxy log is a
single append-only stream, and a re-run reuses the same (agent, task) URL tag,
so filtering by (agent, task) alone merges an attempt with the one it replaced.
Every attempt recreates its job directory, so the newest entry birthtime inside
`harbor-jobs/<tag>__<agent>__<task>/` bounds the current attempt.  Birthtime --
not the oldest file mtime -- because files collected back out of containers keep
their image-build mtimes, which can be weeks old.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_AGENTS = "mica,codex,opencode,kimi-code"
STALE_HEARTBEAT_SECS = 600
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8790

# ---------------------------------------------------------------- small utils


def now_iso(ts: float | None = None) -> str:
    ts = time.time() if ts is None else ts
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def local_hhmm(ts: float | None = None) -> str:
    ts = time.time() if ts is None else ts
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


def human_dur(secs: float | None) -> str:
    if secs is None:
        return "-"
    secs = int(secs)
    if secs < 0:
        secs = 0
    h, rem = divmod(secs, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h{m:02d}m"
    if m:
        return f"{m}m{s:02d}s"
    return f"{s}s"


def read_text(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return None


def parse_iso(ts: str | None) -> float | None:
    if not ts:
        return None
    try:
        t = ts.strip()
        if t.endswith("Z"):
            t = t[:-1] + "+00:00"
        return datetime.fromisoformat(t).timestamp()
    except Exception:
        return None


# ---------------------------------------------------------------- bench layout


def job_dir(bench: str, tag: str, agent: str, task: str) -> str:
    return os.path.join(bench, "harbor-jobs", f"{tag}__{agent}__{task}")


def find_bench_dir(explicit: str | None) -> str:
    if explicit:
        return os.path.abspath(os.path.expanduser(explicit))
    env = os.environ.get("MICA_BENCH_DIR")
    if env:
        return os.path.abspath(os.path.expanduser(env))
    parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if os.path.exists(os.path.join(parent, "tasks.txt")):
        return parent
    return os.path.expanduser("~/mica-bench")


def detect_tag(bench: str) -> str:
    """Newest `runs/<tag>` directory -- the matrix that is being written now."""
    best, best_mt = None, -1.0
    for p in glob.glob(os.path.join(bench, "runs", "*")):
        if not os.path.isdir(p):
            continue
        candidates = [os.path.join(p, "status.tsv"), os.path.join(p, "REPORT.md"), p]
        mt = 0.0
        for c in candidates:
            try:
                mt = max(mt, os.stat(c).st_mtime)
            except OSError:
                pass
        if mt > best_mt:
            best, best_mt = os.path.basename(p), mt
    return best or "reg2"


def load_tasks(bench: str, explicit: str | None) -> list[str]:
    if explicit:
        return [t.strip() for t in explicit.split(",") if t.strip()]
    raw = read_text(os.path.join(bench, "tasks.txt")) or ""
    tasks = [t.strip() for t in raw.replace("\n", ",").split(",") if t.strip()]
    return tasks


def load_agents(bench: str, explicit: str | None) -> list[str]:
    if explicit:
        return [a.strip() for a in explicit.split(",") if a.strip()]
    return DEFAULT_AGENTS.split(",")


def read_started(bench: str, tag: str) -> float | None:
    raw = read_text(os.path.join(bench, f"{tag}.started"))
    return parse_iso(raw)


# ---------------------------------------------------------------- verdict data


def read_status_tsv(bench: str, tag: str) -> dict[tuple[str, str], dict]:
    rows: dict[tuple[str, str], dict] = {}
    raw = read_text(os.path.join(bench, "runs", tag, "status.tsv"))
    if not raw:
        return rows
    for line in raw.splitlines():
        parts = line.rstrip("\n").split("\t")
        if len(parts) != 6:
            continue
        agent, task, rc, reward, wall, note = parts
        rows[(agent, task)] = {
            "rc": rc, "reward": reward, "wall": wall, "note": note,
        }
    return rows


def reward_of(bench: str, tag: str, agent: str, task: str) -> str | None:
    for p in glob.glob(os.path.join(job_dir(bench, tag, agent, task), "*", "verifier", "reward.txt")):
        raw = read_text(p)
        if raw is not None and raw.strip():
            return raw.strip()
    return None


def partial_of(bench: str, tag: str, agent: str, task: str) -> tuple[int, int] | None:
    for p in glob.glob(os.path.join(job_dir(bench, tag, agent, task), "*", "verifier", "ctrf.json")):
        raw = read_text(p)
        if raw is None:
            continue
        try:
            s = json.loads(raw).get("results", {}).get("summary", {})
        except Exception:
            continue
        passed, failed = s.get("passed"), s.get("failed")
        if passed is None and failed is None:
            continue
        return int(passed or 0), int(failed or 0)
    return None


def phases_of(bench: str, tag: str, agent: str, task: str) -> dict:
    """Per-phase seconds + exception_type from result.json."""
    out = {"setup": None, "exec": None, "verify": None, "exception_type": None,
           "exception": False, "started_at": None, "finished_at": None}
    for p in glob.glob(os.path.join(job_dir(bench, tag, agent, task), "*", "result.json")):
        raw = read_text(p)
        if raw is None:
            continue
        try:
            j = json.loads(raw)
        except Exception:
            continue
        if not isinstance(j, dict):
            continue

        def span(key):
            blk = j.get(key) or {}
            a = parse_iso(blk.get("started_at"))
            b = parse_iso(blk.get("finished_at"))
            if a is None or b is None:
                return None
            return int(round(b - a))

        out["setup"] = span("agent_setup")
        out["exec"] = span("agent_execution")
        out["verify"] = span("verifier")
        out["started_at"] = j.get("started_at")
        out["finished_at"] = j.get("finished_at")
        info = j.get("exception_info") or {}
        if info.get("exception_type"):
            out["exception_type"] = info["exception_type"]
            out["exception"] = True
        return out
    return out


def exception_of(bench: str, tag: str, agent: str, task: str, exc_type: str | None) -> str | None:
    """Short label, e.g. AgentTimeoutError (result.json first, exception.txt fallback)."""
    if exc_type:
        return exc_type
    for p in glob.glob(os.path.join(job_dir(bench, tag, agent, task), "*", "exception.txt")):
        raw = read_text(p) or ""
        for line in reversed([l.strip() for l in raw.splitlines() if l.strip()]):
            if "Error" in line or "Exception" in line or "Timeout" in line:
                return line.split(":")[0][-40:]
    return None


def attempt_since(bench: str, tag: str, agent: str, task: str, now: float) -> float | None:
    """When the cell's *current* attempt started (epoch secs), clamped to now.

    Newest birthtime across every entry in the job dir: the job dir is wiped and
    recreated per attempt, so the newest entry bounds the current attempt.  Uses
    birthtime, never file mtime -- container-collected files keep image-build
    mtimes that can be weeks old.
    """
    d = job_dir(bench, tag, agent, task)
    best = 0.0
    try:
        entries = os.listdir(d)
    except OSError:
        return None
    for name in entries:
        try:
            st = os.stat(os.path.join(d, name))
        except OSError:
            continue
        born = getattr(st, "st_birthtime", None) or st.st_ctime
        if born > best:
            best = born
    if not best:
        return None
    return min(best, now)


def newest_attempt(bench: str, tag: str, agent: str, task: str) -> str | None:
    best, best_born = None, -1.0
    for p in glob.glob(os.path.join(job_dir(bench, tag, agent, task), "*")):
        if not os.path.isdir(p):
            continue
        try:
            st = os.stat(p)
        except OSError:
            continue
        born = getattr(st, "st_birthtime", None) or st.st_ctime
        if born > best_born:
            best, best_born = p, born
    return best


def heartbeat_mtime(attempt: str | None, now: float) -> float | None:
    """Newest mtime under an attempt dir -- the liveness heartbeat.

    Bounded walk (max depth 6, max 800 entries): only ever called for the
    handful of cells that are currently running.
    """
    if not attempt:
        return None
    newest = 0.0
    seen = 0
    for root, dirs, files in os.walk(attempt):
        depth = root[len(attempt):].count(os.sep)
        if depth >= 6:
            dirs[:] = []
        for name in dirs + files:
            seen += 1
            if seen > 800:
                return newest or None
            try:
                st = os.stat(os.path.join(root, name))
            except OSError:
                continue
            if st.st_mtime > newest:
                newest = st.st_mtime
    return newest or None


# ---------------------------------------------------------------- live cells

CELL_RE = re.compile(r"(?:^|/)cell\d*\.sh\s+(\S+)\s+(\S+)\s+(\S+)\s*$")
PS_LINE_RE = re.compile(r"^\s*(\d+)\s+(\S+)\s+(.*)$")
BENCHRUN_RE = re.compile(r"bench-run\d*\.sh\s+(\S+)")


def parse_etime(s: str) -> int | None:
    days = 0
    if "-" in s:
        head, s = s.split("-", 1)
        try:
            days = int(head)
        except ValueError:
            return None
    parts = s.split(":")
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return None
    if len(nums) == 3:
        h, m, sec = nums
    elif len(nums) == 2:
        h, m, sec = 0, nums[0], nums[1]
    else:
        return None
    return days * 86400 + h * 3600 + m * 60 + sec


def ps_snapshot() -> str:
    try:
        return subprocess.run(
            ["ps", "-Ao", "pid=,etime=,command="],
            capture_output=True, text=True, timeout=15,
        ).stdout
    except Exception:
        try:
            return subprocess.run(
                ["ps", "-eo", "pid=,etime=,command="],
                capture_output=True, text=True, timeout=15,
            ).stdout
        except Exception:
            return ""


def live_cells(bench: str, tag: str, now: float) -> tuple[list[dict], bool]:
    out: list[dict] = []
    snapshot = ps_snapshot()
    scheduler = False
    for line in snapshot.splitlines():
        m = BENCHRUN_RE.search(line)
        if m and m.group(1) == tag:
            scheduler = True
            break
    for line in snapshot.splitlines():
        m = PS_LINE_RE.match(line)
        if not m:
            continue
        pid, etime, command = m.group(1), m.group(2), m.group(3)
        c = CELL_RE.search(command)
        if not c:
            continue
        ctag, agent, task = c.group(1), c.group(2), c.group(3)
        if ctag != tag:
            continue
        attempt = newest_attempt(bench, tag, agent, task)
        hb = heartbeat_mtime(attempt, now)
        born = None
        if attempt:
            try:
                st = os.stat(attempt)
                born = getattr(st, "st_birthtime", None) or st.st_ctime
            except OSError:
                born = None
        out.append({
            "pid": int(pid),
            "agent": agent,
            "task": task,
            "command": command.strip(),
            "process_age_secs": parse_etime(etime),
            "attempt_age_secs": int(now - born) if born else None,
            "heartbeat_age_secs": int(now - hb) if hb else None,
            "heartbeat_at": hb,
        })
    out.sort(key=lambda r: (r["agent"], r["task"]))
    return out, scheduler


# ---------------------------------------------------------------- proxy events

_EVENTS_CACHE: dict[str, tuple[int, float, list]] = {}


def load_events(path: str) -> list[dict]:
    """Parse events.jsonl; re-parse only when size or mtime moved."""
    try:
        st = os.stat(path)
    except OSError:
        return []
    key = (st.st_size, st.st_mtime)
    cached = _EVENTS_CACHE.get(path)
    if cached and cached[0] == key[0] and cached[1] == key[1]:
        return cached[2]
    rows: list[dict] = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    _EVENTS_CACHE[path] = (key[0], key[1], rows)
    return rows


def blank_cell() -> dict:
    return {"rounds": 0, "probes": 0, "errors": 0, "prompt": 0, "cached": 0,
            "output": 0, "reasoning": 0, "tools": 0, "peak": 0,
            "latest_seq": 0, "first_ts": None, "last_ts": None, "rows": 0}


def is_probe(row: dict) -> bool:
    """codex probes `GET /responses`, gets 405 -- harness noise, not a failure."""
    return (row.get("method") or "POST").upper() == "GET"


def aggregate(events: list[dict], windows: dict[tuple[str, str], float | None],
              agents: list[str], tasks: list[str]):
    cells: dict[tuple[str, str], dict] = defaultdict(blank_cell)
    err_rows: list[dict] = []
    excluded = {"rows": 0, "errors": 0, "probes": 0}
    for r in events:
        key = (r.get("agent"), r.get("task"))
        if key not in windows:
            continue  # an agent/task outside this matrix
        cut = windows[key]
        ts = r.get("ts") or 0
        if cut is not None and ts and ts < cut:
            # Superseded attempt: a re-run reuses the same URL tag, so these
            # rows belong to the attempt that was replaced.  Counted so a
            # "0 errors" reading is explainable rather than suspicious.
            excluded["rows"] += 1
            if is_probe(r):
                excluded["probes"] += 1
            elif (r.get("status") or 0) >= 400 or r.get("proxy_error"):
                excluded["errors"] += 1
            continue
        c = cells[key]
        c["rows"] += 1
        seq = r.get("seq") or 0
        if seq > c["latest_seq"]:
            c["latest_seq"] = seq
        if ts:
            c["first_ts"] = ts if c["first_ts"] is None else min(c["first_ts"], ts)
            c["last_ts"] = ts if c["last_ts"] is None else max(c["last_ts"], ts)
        if is_probe(r):
            c["probes"] += 1
        else:
            c["rounds"] += 1
            status = r.get("status") or 0
            if status >= 400 or r.get("proxy_error"):
                c["errors"] += 1
                err_rows.append({
                    "ts": ts, "ts_iso": now_iso(ts) if ts else None,
                    "agent": r.get("agent"), "task": r.get("task"),
                    "seq": seq, "status": status,
                    "method": r.get("method") or "POST",
                    "path": r.get("upstream_path"),
                    "proxy_error": bool(r.get("proxy_error")),
                })
        c["tools"] += r.get("tool_calls") or 0
        u = r.get("usage") or {}
        if u.get("input") is not None:
            c["prompt"] += u["input"]
            c["cached"] += u.get("cached") or 0
            c["output"] += u.get("output") or 0
            c["reasoning"] += u.get("reasoning") or 0
            c["peak"] = max(c["peak"], u["input"])
    err_rows.sort(key=lambda e: e["ts"] or 0, reverse=True)
    return cells, err_rows, excluded


def timeline(events: list[dict], windows: dict, since: float | None, now: float):
    """Requests-per-bucket, for the little throughput sparkline."""
    ts = [r.get("ts") for r in events if r.get("ts")]
    if not ts:
        return {"bucket_secs": 60, "buckets": [], "label": "requests"}
    lo = since if since else min(ts)
    span = max(now - lo, 60.0)
    bucket = 60
    while span / bucket > 300:
        bucket *= 2
    n = int(span // bucket) + 1
    buckets = [0] * n
    for r in events:
        t = r.get("ts")
        if not t:
            continue
        key = (r.get("agent"), r.get("task"))
        if key not in windows:
            continue
        cut = windows[key]
        if cut is not None and t < cut:
            continue
        i = int((t - lo) // bucket)
        if 0 <= i < n:
            buckets[i] += 1
    return {"bucket_secs": bucket, "start": lo, "buckets": buckets}


# ---------------------------------------------------------------- payload


def build_payload(cfg: dict) -> dict:
    now = time.time()
    bench = cfg["bench"]
    tag = cfg["tag"] or detect_tag(bench)
    agents = load_agents(bench, cfg["agents"])
    tasks = load_tasks(bench, cfg["tasks"])
    conc = cfg["concurrency"]
    stale = cfg["stale_secs"]

    started = read_started(bench, tag)
    status_rows = read_status_tsv(bench, tag)

    windows: dict[tuple[str, str], float | None] = {}
    for t in tasks:
        for a in agents:
            windows[(a, t)] = attempt_since(bench, tag, a, t, now)

    # global fallback window: only used for cells with no attempt dir at all
    if started is None:
        cands = [v for v in windows.values() if v]
        started = min(cands) if cands else None
    if started is not None:
        for key, v in list(windows.items()):
            if v is None:
                windows[key] = started

    events = load_events(os.path.join(bench, "events.jsonl"))
    cells, err_rows, excluded = aggregate(events, windows, agents, tasks)

    live, scheduler_running = live_cells(bench, tag, now)
    live_by_key = {(c["agent"], c["task"]): c for c in live}

    matrix: list[dict] = []
    counts = defaultdict(int)
    stalled_done = 0
    walls: list[float] = []

    for t in tasks:
        for a in agents:
            key = (a, t)
            c = cells.get(key) or blank_cell()
            row = status_rows.get(key)
            reward = reward_of(bench, tag, a, t)
            partial = partial_of(bench, tag, a, t)
            ph = phases_of(bench, tag, a, t)
            exc_name = exception_of(bench, tag, a, t, ph["exception_type"])
            has_exc_file = bool(glob.glob(os.path.join(job_dir(bench, tag, a, t), "*", "exception.txt")))
            done = row is not None or reward is not None or has_exc_file
            note = row["note"] if row else None
            caveat = None
            if reward is None and row is not None and row["reward"] not in ("", "NA"):
                reward = row["reward"]
                caveat = "reward from status.tsv"
            elif reward is None and has_exc_file:
                reward = "NA"
                caveat = "no reward.txt"

            if done:
                if reward == "1":
                    state = "pass"
                elif exc_name and "timeout" in exc_name.lower():
                    state = "timeout"
                elif note == "stalled":
                    state = "stalled"
                elif exc_name or has_exc_file:
                    state = "exception"
                else:
                    state = "fail"
            else:
                lv = live_by_key.get(key)
                if lv:
                    hb = lv["heartbeat_age_secs"]
                    # Both signals must be quiet before calling a live cell
                    # stalled: the heartbeat file can lag while a long model
                    # request is in flight, so a stale heartbeat alone is not
                    # proof that the agent stopped talking to the proxy.
                    req_age = int(now - c["last_ts"]) if c["last_ts"] else None
                    quiet_hb = hb is not None and hb > stale
                    quiet_req = (req_age is None) or (req_age > stale)
                    state = "stalled" if (quiet_hb and quiet_req) else "running"
                else:
                    state = "pending"

            wall = None
            if row and row["wall"] not in ("", "0"):
                try:
                    wall = int(row["wall"])
                except ValueError:
                    wall = None
            if wall is None and done:
                tot = sum(x for x in (ph["setup"], ph["exec"], ph["verify"]) if x)
                wall = tot or None
            if done and wall:
                walls.append(wall)

            matrix.append({
                "agent": a, "task": t, "key": f"{a}__{t}",
                "state": state,
                "done": bool(done),
                "reward": reward if reward is not None else None,
                "partial": (f"{partial[0]}/{partial[0] + partial[1]}" if partial else None),
                "partial_passed": partial[0] if partial else None,
                "partial_total": (partial[0] + partial[1]) if partial else None,
                "wall_secs": wall,
                "wall_source": ("status.tsv" if (row and row["wall"] not in ("", "0"))
                                else ("phase sum" if wall else None)),
                "note": note,
                "exception": exc_name,
                "caveat": caveat,
                "phases": {"setup": ph["setup"], "exec": ph["exec"], "verify": ph["verify"]},
                "started_at": ph["started_at"],
                "finished_at": ph["finished_at"],
                "rounds": c["rounds"], "probes": c["probes"], "errors": c["errors"],
                "prompt_tokens": c["prompt"], "cached_tokens": c["cached"],
                "output_tokens": c["output"], "reasoning_tokens": c["reasoning"],
                "tools": c["tools"], "peak_ctx": c["peak"], "latest_seq": c["latest_seq"],
                "last_request_at": c["last_ts"],
                "last_request_age_secs": int(now - c["last_ts"]) if c["last_ts"] else None,
                "attribution_since": windows.get(key),
                "has_events": c["rows"] > 0,
                "running": key in live_by_key,
                "heartbeat_age_secs": live_by_key[key]["heartbeat_age_secs"] if key in live_by_key else None,
                "process_age_secs": live_by_key[key]["process_age_secs"] if key in live_by_key else None,
                "attempt_age_secs": live_by_key[key]["attempt_age_secs"] if key in live_by_key else None,
                "pid": live_by_key[key]["pid"] if key in live_by_key else None,
            })
            counts[state] += 1
            if done and state == "stalled":
                # a cell the scheduler killed as stalled: finished, no reward.
                # Kept distinct from a *live* stalled cell so
                # done + running + pending always sums to the matrix size.
                stalled_done += 1

    total = len(tasks) * len(agents)
    done = sum(1 for m in matrix if m["done"])
    running_now = counts["running"]
    stalled_now = counts["stalled"] - stalled_done
    live_with_verdict = len(live) - running_now - stalled_now
    remaining = total - done
    mean_wall = (sum(walls) / len(walls)) if walls else None
    elapsed = (now - started) if started else None

    eta_secs = None
    if mean_wall and remaining > 0:
        eta_secs = remaining * mean_wall / max(conc, 1)
    eta_throughput = None
    if elapsed and elapsed > 0 and done > 0 and remaining > 0:
        eta_throughput = remaining * (elapsed / done)

    by_agent: list[dict] = []
    for a in agents:
        rows = [m for m in matrix if m["agent"] == a]
        part_p = sum(m["partial_passed"] or 0 for m in rows if m["partial"])
        part_t = sum(m["partial_total"] or 0 for m in rows if m["partial"])
        prompt = sum(m["prompt_tokens"] for m in rows)
        cached = sum(m["cached_tokens"] for m in rows)
        by_agent.append({
            "agent": a,
            "cells": len(rows),
            "done": sum(1 for m in rows if m["done"]),
            "running": sum(1 for m in rows if m["running"]),
            "passed": sum(1 for m in rows if m["state"] == "pass"),
            "partial": (f"{part_p}/{part_t}" if part_t else None),
            "rounds": sum(m["rounds"] for m in rows),
            "prompt_tokens": prompt,
            "cached_tokens": cached,
            "cached_pct": round(100.0 * cached / prompt, 1) if prompt else None,
            "output_tokens": sum(m["output_tokens"] for m in rows),
            "peak_ctx": max((m["peak_ctx"] for m in rows), default=0),
            "tools": sum(m["tools"] for m in rows),
            "errors": sum(m["errors"] for m in rows),
            "probes": sum(m["probes"] for m in rows),
            "wall_secs": sum(m["wall_secs"] or 0 for m in rows),
        })

    err_by_agent = {a: sum(1 for e in err_rows if e["agent"] == a) for a in agents}

    return {
        "generated_at": now,
        "generated_at_iso": now_iso(now),
        "generated_at_local": local_hhmm(now),
        "tag": tag,
        "bench_dir": bench,
        "agents": agents,
        "tasks": tasks,
        "progress": {
            "total": total, "done": done, "remaining": remaining,
            "running": running_now, "stalled": stalled_now,
            "live_processes": len(live), "live_with_verdict": max(live_with_verdict, 0),
            "stalled_done": stalled_done,
            "state_counts": {k: counts[k] for k in
                             ("pass", "fail", "timeout", "exception", "stalled",
                              "running", "pending")},
            "pending": counts["pending"], "passed": counts["pass"], "failed": counts["fail"],
            "timeout": counts["timeout"], "exception": counts["exception"],
            "done_pct": round(100.0 * done / total, 1) if total else 0,
            "started_at": started, "started_at_iso": now_iso(started) if started else None,
            "elapsed_secs": elapsed,
            "mean_cell_wall_secs": mean_wall,
            "concurrency": conc,
            "eta_secs": eta_secs,
            "eta_at": (now + eta_secs) if eta_secs else None,
            "eta_at_local": local_hhmm(now + eta_secs) if eta_secs else None,
            "eta_throughput_secs": eta_throughput,
            "eta_throughput_at_local": local_hhmm(now + eta_throughput) if eta_throughput else None,
            "scheduler_running": scheduler_running,
            "stale_secs": stale,
        },
        "matrix": matrix,
        "live": live,
        "by_agent": by_agent,
        "errors": {
            "total": len(err_rows), "by_agent": err_by_agent, "recent": err_rows[:40],
            "excluded": excluded,
        },
        "timeline": timeline(events, windows, started, now),
        "sources": {
            "events_path": os.path.join(bench, "events.jsonl"),
            "events_rows": len(events),
            "events_rows_in_window": sum(m["rounds"] + m["probes"] for m in matrix),
            "status_rows": len(status_rows),
            "backfilled_cells": sum(1 for m in matrix if m["done"] and (m["agent"], m["task"]) not in status_rows),
            "attribution": "newest birthtime in harbor-jobs/<tag>__<agent>__<task>/, clamped to now",
            "started_file": os.path.join(bench, f"{tag}.started"),
            "excluded_rows": excluded["rows"],
            "excluded_errors": excluded["errors"],
        },
    }


# ---------------------------------------------------------------- page

PAGE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mica-bench dashboard</title>
<style>
  :root {
    --bg: #0e1116; --panel: #151a21; --panel-hi: #1b2129; --line: #262d37;
    --fg: #d6dde6; --dim: #8b97a5; --dim2: #626d7a;
    --accent: #58a6ff; --pass: #3fb950; --fail: #f85149; --warn: #d29922;
    --exc: #db6d28; --run: #58a6ff; --pending: #39414d;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 13px/1.45 var(--mono); -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); }
  header {
    position: sticky; top: 0; z-index: 5; background: var(--panel);
    border-bottom: 1px solid var(--line); padding: 10px 16px;
    display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap;
  }
  header h1 { font-size: 14px; margin: 0; font-weight: 600; letter-spacing: .02em; }
  header .meta { color: var(--dim); font-size: 12px; }
  header .spacer { flex: 1 1 auto; }
  header label { color: var(--dim); font-size: 12px; cursor: pointer; user-select: none; }
  main { padding: 16px; display: flex; flex-direction: column; gap: 20px; max-width: 1500px; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
  section > h2 {
    margin: 0; padding: 9px 12px; font-size: 12px; font-weight: 600;
    letter-spacing: .06em; text-transform: uppercase; color: var(--dim);
    border-bottom: 1px solid var(--line);
  }
  .body { padding: 12px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .dim { color: var(--dim); }
  .dim2 { color: var(--dim2); }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 4px 8px; border-bottom: 1px solid var(--line); text-align: left; }
  th { color: var(--dim); font-weight: 500; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
  tbody tr:hover { background: var(--panel-hi); }
  tbody tr:last-child td { border-bottom: none; }
  .cards { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
  .card {
    background: var(--panel-hi); border: 1px solid var(--line); border-radius: 5px;
    padding: 7px 11px; min-width: 92px;
  }
  .card .k { color: var(--dim); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
  .card .v { font-size: 18px; font-variant-numeric: tabular-nums; }
  .card .s { color: var(--dim2); font-size: 11px; }
  .bar { height: 12px; background: #10141a; border: 1px solid var(--line); border-radius: 3px; overflow: hidden; display: flex; }
  .bar > span { display: block; height: 100%; }
  .b-pass { background: var(--pass); } .b-fail { background: var(--fail); }
  .b-exc { background: var(--exc); } .b-to { background: var(--warn); }
  .b-run { background: var(--run); } .b-stall { background: var(--warn); }
  .legend { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; color: var(--dim); font-size: 11px; }
  .legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; }
  /* matrix */
  .matrix { table-layout: fixed; }
  .matrix th { vertical-align: bottom; }
  .matrix th.rowhead { width: 108px; }
  .matrix th.taskhead { font-size: 10px; color: var(--dim); text-transform: none; letter-spacing: 0; word-break: break-word; }
  .matrix td { padding: 0; border: 1px solid var(--bg); }
  .cell { display: block; padding: 5px 6px; min-height: 40px; border-left: 3px solid transparent; }
  .cell .ci { font-size: 12px; font-variant-numeric: tabular-nums; }
  .cell .cs { font-size: 10px; color: var(--dim); font-variant-numeric: tabular-nums; }
  .st-pass  { background: rgba(63,185,80,.16);  border-left-color: var(--pass); }
  .st-fail  { background: rgba(248,81,73,.14);  border-left-color: var(--fail); }
  .st-exception { background: rgba(219,109,40,.16); border-left-color: var(--exc); }
  .st-timeout { background: rgba(210,153,34,.16); border-left-color: var(--warn); }
  .st-stalled { background: rgba(210,153,34,.10); border-left-color: var(--warn);
                border-left-style: dashed; }
  .st-running { background: rgba(88,166,255,.14); border-left-color: var(--run);
                animation: pulse 2s ease-in-out infinite; }
  .st-pending { background: #12161c; border-left-color: var(--pending); }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .55 } }
  .tag { display: inline-block; padding: 0 5px; border-radius: 3px; font-size: 10px;
         border: 1px solid var(--line); color: var(--dim); }
  .tag.run { border-color: var(--run); color: var(--run); }
  .tag.stale { border-color: var(--warn); color: var(--warn); }
  .tag.pass { border-color: var(--pass); color: var(--pass); }
  .tag.fail { border-color: var(--fail); color: var(--fail); }
  .tag.exc { border-color: var(--exc); color: var(--exc); }
  .tag.to { border-color: var(--warn); color: var(--warn); }
  .tag.pending { color: var(--dim2); }
  .heat { display: inline-block; width: 46px; height: 7px; background: #10141a;
          border: 1px solid var(--line); border-radius: 2px; vertical-align: middle; }
  .heat > i { display: block; height: 100%; background: var(--accent); }
  svg.spark { display: block; width: 100%; height: 34px; }
  .err { color: var(--fail); }
  .muted { color: var(--dim2); font-size: 11px; }
  .scroll { overflow: auto; }
  select { background: var(--panel-hi); color: var(--fg); border: 1px solid var(--line);
           border-radius: 4px; padding: 3px 6px; font: inherit; font-size: 11px; }
</style>
</head>
<body>
<header>
  <h1>mica-bench <span id="tag" class="dim">-</span></h1>
  <span class="meta" id="stamp">loading...</span>
  <span class="meta" id="pills"></span>
  <span class="spacer"></span>
  <label><input type="checkbox" id="auto" checked> auto 5s</label>
  <span class="meta" id="tick"></span>
</header>
<main>
  <section>
    <h2>Progress</h2>
    <div class="body">
      <div class="cards" id="cards"></div>
      <div class="bar" id="bar"></div>
      <div class="legend" id="legend"></div>
      <div style="margin-top:12px" id="spark-wrap"></div>
    </div>
  </section>
  <section>
    <h2>Matrix &mdash; agents &times; tasks</h2>
    <div class="body scroll" id="matrix-wrap"></div>
  </section>
  <section>
    <h2>Live cells</h2>
    <div class="body scroll" id="live-wrap"></div>
  </section>
  <section>
    <h2>Per-agent totals</h2>
    <div class="body scroll" id="totals-wrap"></div>
  </section>
  <section>
    <h2>Per-cell tokens &amp; rounds <span class="muted" id="cells-sort-note"></span></h2>
    <div class="body">
      <div style="margin-bottom:8px">
        sort by
        <select id="cell-sort">
          <option value="task">task / agent</option>
          <option value="prompt_tokens">prompt tokens</option>
          <option value="rounds">rounds</option>
          <option value="peak_ctx">peak ctx</option>
          <option value="output_tokens">output tokens</option>
          <option value="wall_secs">wall</option>
        </select>
      </div>
      <div class="scroll" id="cells-wrap"></div>
    </div>
  </section>
  <section>
    <h2>Errors <span class="muted" id="errors-note"></span></h2>
    <div class="body scroll" id="errors-wrap"></div>
  </section>
  <section>
    <h2>Sources &amp; how numbers are derived</h2>
    <div class="body" id="sources-wrap"></div>
  </section>
</main>
<script>
(function () {
  "use strict";
  var state = { data: null, next: 0, failures: 0 };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function fmtK(n) {
    if (n === null || n === undefined) return "-";
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(n);
  }
  function fmtDur(s) {
    if (s === null || s === undefined) return "-";
    s = Math.max(0, Math.round(s));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    if (h) return h + "h" + String(m).padStart(2, "0") + "m";
    if (m) return m + "m" + String(ss).padStart(2, "0") + "s";
    return ss + "s";
  }
  function fmtAgo(s) {
    if (s === null || s === undefined) return "-";
    if (s < 90) return s + "s";
    return fmtDur(s);
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // rows: array of arrays; each cell is a string, number, or {t, c, title}
  function table(headers, rows) {
    var t = el("table"), thead = el("thead"), tr = el("tr");
    headers.forEach(function (h) {
      var th = el("th", h.num ? "num" : "");
      th.textContent = h.label !== undefined ? h.label : h;
      tr.appendChild(th);
    });
    thead.appendChild(tr); t.appendChild(thead);
    var tb = el("tbody");
    rows.forEach(function (row) {
      var r = el("tr");
      row.forEach(function (cell) {
        var v = (cell && typeof cell === "object") ? cell : { t: cell };
        var td = el("td", v.c || "");
        if (v.t !== undefined && v.t !== null) td.textContent = String(v.t);
        if (v.title) td.title = v.title;
        if (v.child) td.appendChild(v.child);
        r.appendChild(td);
      });
      tb.appendChild(r);
    });
    t.appendChild(tb);
    return t;
  }

  function stateTag(m) {
    var map = {
      pass: ["PASS", "pass"], fail: ["FAIL", "fail"], exception: ["EXC", "exc"],
      timeout: ["TIMEOUT", "to"], stalled: ["STALE", "stale"],
      running: ["RUNNING", "run"], pending: ["pending", "pending"]
    };
    var v = map[m.state] || [m.state, ""];
    var s = el("span", "tag " + v[1], v[0]);
    return s;
  }

  function renderProgress(d) {
    var p = d.progress;
    var cards = document.getElementById("cards");
    clear(cards);
    function card(k, v, s) {
      var c = el("div", "card");
      c.appendChild(el("div", "k", k));
      c.appendChild(el("div", "v", v));
      if (s) c.appendChild(el("div", "s", s));
      cards.appendChild(c);
    }
    card("cells done", p.done + " / " + p.total, p.done_pct + "%");
    card("running", p.running, p.live_processes + " cell*.sh in ps");
    card("stalled now", p.stalled, p.stalled_done ? p.stalled_done + " stalled verdict" : "quiet > " + p.stale_secs + "s");
    card("pending", p.pending, "not started");
    card("passed", p.passed, "reward = 1");
    card("failed", p.failed, p.timeout ? "+" + p.timeout + " timeout" : null);
    card("exception", p.exception, p.stalled_done ? p.stalled_done + " stalled" : null);
    card("elapsed", fmtDur(p.elapsed_secs), p.started_at_iso ? "since " + p.started_at_iso : "no start file");
    card("eta", p.eta_secs ? fmtDur(p.eta_secs) : "n/a",
         p.eta_at_local ? "~" + p.eta_at_local : "no wall samples");
    card("mean cell", p.mean_cell_wall_secs ? fmtDur(p.mean_cell_wall_secs) : "-",
         p.eta_throughput_at_local ? "throughput eta ~" + p.eta_throughput_at_local : null);

    var bar = document.getElementById("bar");
    clear(bar);
    var order = [["pass", "b-pass"], ["fail", "b-fail"], ["exception", "b-exc"],
                 ["timeout", "b-to"], ["stalled", "b-stall"], ["running", "b-run"]];
    var nums = p.state_counts;
    order.forEach(function (o) {
      var n = nums[o[0]] || 0;
      if (!n) return;
      var s = el("span", o[1]);
      s.style.width = (100 * n / p.total) + "%";
      s.title = n + " " + o[0];
      bar.appendChild(s);
    });

    var lg = document.getElementById("legend");
    clear(lg);
    [["pass", "var(--pass)"], ["fail", "var(--fail)"], ["exception", "var(--exc)"],
     ["timeout", "var(--warn)"], ["stalled", "var(--warn)"], ["running", "var(--run)"],
     ["pending", "var(--pending)"]].forEach(function (o) {
      var s = el("span");
      var i = el("i"); i.style.background = o[1];
      var n = nums[o[0]] || 0;
      i.style.opacity = n ? "1" : ".25";
      s.appendChild(i);
      s.appendChild(document.createTextNode(o[0] + " " + n +
        (o[0] === "stalled" && p.stalled_done ? " (" + p.stalled + " live / " + p.stalled_done + " verdict)" : "")));
      lg.appendChild(s);
    });
    var inv = el("span", "dim2");
    var lwv = p.live_with_verdict || 0;
    inv.textContent = "done " + p.done + " + running " + p.running + " + stalled(live) " +
      p.stalled + " + pending " + p.pending + (lwv ? " + live-with-verdict " + lwv : "") +
      " = " + (p.done + p.running + p.stalled + p.pending + lwv) + " / " + p.total;
    lg.appendChild(inv);

    // sparkline: requests per bucket
    var wrap = document.getElementById("spark-wrap");
    clear(wrap);
    var tl = d.timeline;
    if (tl && tl.buckets && tl.buckets.length > 1) {
      var w = 1200, h = 34, b = tl.buckets, mx = Math.max.apply(null, b) || 1;
      var pts = b.map(function (v, i) {
        var x = (i / (b.length - 1)) * w;
        var y = h - (v / mx) * (h - 3) - 1;
        return x.toFixed(1) + "," + y.toFixed(1);
      }).join(" ");
      var area = "0," + h + " " + pts + " " + w + "," + h;
      wrap.innerHTML =
        '<div class="muted">requests per ' + tl.bucket_secs + 's (peak ' + mx + '/bucket)</div>' +
        '<svg class="spark" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none">' +
        '<polygon points="' + area + '" fill="rgba(88,166,255,.18)"/>' +
        '<polyline points="' + pts + '" fill="none" stroke="var(--accent)" stroke-width="1.2"/></svg>';
    }
  }

  function renderMatrix(d) {
    var wrap = document.getElementById("matrix-wrap");
    clear(wrap);
    var t = el("table", "matrix");
    var thead = el("thead"), tr = el("tr");
    var th0 = el("th", "rowhead", "agent \\ task");
    tr.appendChild(th0);
    d.tasks.forEach(function (task) {
      var th = el("th", "taskhead", task);
      th.title = task;
      tr.appendChild(th);
    });
    thead.appendChild(tr); t.appendChild(thead);
    var tb = el("tbody");
    d.agents.forEach(function (agent) {
      var r = el("tr");
      var th = el("th", "rowhead", agent);
      r.appendChild(th);
      d.tasks.forEach(function (task) {
        var key = agent + "__" + task;
        var m = d.matrix.filter(function (x) { return x.key === key; })[0];
        var td = el("td");
        if (!m) { td.appendChild(el("span", "dim2", "-")); r.appendChild(td); return; }
        var c = el("span", "cell st-" + m.state);
        var main = "";
        if (m.state === "pass") main = "\u2713" + (m.partial ? " " + m.partial : "");
        else if (m.state === "fail") main = "\u2717" + (m.partial ? " " + m.partial : "");
        else if (m.state === "timeout") main = "\u23f1" + (m.partial ? " " + m.partial : "");
        else if (m.state === "exception") main = "!" + (m.partial ? " " + m.partial : "");
        else if (m.state === "running") main = (m.rounds || 0) + "r";
        else if (m.state === "stalled") main = "\u26a0 " + (m.rounds || 0) + "r";
        else if (m.has_events) main = "\u00b7 " + (m.rounds || 0) + "r";
        else main = "\u00b7";
        c.appendChild(el("div", "ci", main));
        var sub = "";
        if (m.state === "running" || m.state === "stalled") {
          sub = fmtDur(m.process_age_secs) + " \u00b7 hb " + fmtAgo(m.heartbeat_age_secs);
        } else if (m.done) {
          sub = fmtDur(m.wall_secs) + " \u00b7 " + fmtK(m.prompt_tokens);
        } else if (m.has_events) {
          sub = "partial activity";
        } else {
          sub = "not started";
        }
        c.appendChild(el("div", "cs", sub));
        td.appendChild(c);
        var tip = agent + " / " + task + "\nstate: " + m.state;
        if (m.reward !== null && m.reward !== undefined) tip += "\nreward: " + m.reward;
        if (m.partial) tip += "\npartial: " + m.partial;
        if (m.exception) tip += "\nexception: " + m.exception;
        if (m.wall_secs) tip += "\nwall: " + m.wall_secs + "s" + (m.wall_source ? " (" + m.wall_source + ")" : "");
        tip += "\nrounds: " + m.rounds + "  probes: " + m.probes + "  errors: " + m.errors;
        tip += "\nprompt: " + m.prompt_tokens + "  peak ctx: " + m.peak_ctx;
        tip += "\noutput: " + m.output_tokens;
        if (m.caveat) tip += "\nnote: " + m.caveat;
        if (m.note) tip += "\nstatus.tsv note: " + m.note;
        tip += "\nattribution window from: " + (m.attribution_since ? new Date(m.attribution_since * 1000).toLocaleString() : "none");
        td.title = tip;
        r.appendChild(td);
      });
      tb.appendChild(r);
    });
    t.appendChild(tb);
    wrap.appendChild(t);
  }

  function renderLive(d) {
    var wrap = document.getElementById("live-wrap");
    clear(wrap);
    var rows = d.live.map(function (l) {
      var key = l.agent + "__" + l.task;
      var m = d.matrix.filter(function (x) { return x.key === key; })[0] || {};
      var stale = l.heartbeat_age_secs !== null && l.heartbeat_age_secs > d.progress.stale_secs;
      var state = (m.state === "stalled" || stale) ? "stalled" : "running";
      return [
        l.agent, l.task, { t: l.pid, c: "num" },
        { t: fmtDur(l.process_age_secs), c: "num" },
        { t: fmtDur(l.attempt_age_secs), c: "num" },
        { t: l.heartbeat_age_secs === null ? "-" : fmtAgo(l.heartbeat_age_secs),
          c: "num" + (stale ? " err" : ""),
          title: "newest mtime under the attempt dir (agent stdout / session files)" },
        { t: m.rounds || 0, c: "num" },
        { t: m.latest_seq || 0, c: "num" },
        { t: fmtK(m.prompt_tokens), c: "num" },
        { t: fmtK(m.peak_ctx), c: "num" },
        { t: fmtK(m.output_tokens), c: "num" },
        { t: fmtDur(m.last_request_age_secs), c: "num" },
        { t: m.errors || 0, c: "num" + (m.errors ? " err" : "") },
        state
      ];
    });
    if (!rows.length) {
      wrap.appendChild(el("div", "dim", d.progress.scheduler_running
        ? "no cell*.sh process for tag " + d.tag + " (scheduler alive -- between dispatches?)"
        : "no cell*.sh process for tag " + d.tag + "; scheduler not detected in ps"));
      return;
    }
    wrap.appendChild(table([
      "agent", "task", { label: "pid", num: true }, { label: "proc age", num: true },
      { label: "attempt age", num: true }, { label: "heartbeat", num: true },
      { label: "rounds", num: true }, { label: "last seq", num: true },
      { label: "prompt", num: true }, { label: "peak ctx", num: true },
      { label: "output", num: true }, { label: "last req", num: true },
      { label: "err", num: true }, "state"
    ], rows));
    var note = el("div", "muted");
    note.style.marginTop = "8px";
    note.textContent = "heartbeat = newest mtime under harbor-jobs/<tag>__<agent>__<task>/<attempt>/; " +
      "stale when older than " + d.progress.stale_secs + "s and no request in the same window.";
    wrap.appendChild(note);
  }

  function renderTotals(d) {
    var wrap = document.getElementById("totals-wrap");
    clear(wrap);
    var rows = d.by_agent.map(function (a) {
      return [
        a.agent,
        { t: a.done + "/" + a.cells, c: "num" },
        { t: a.running || 0, c: "num" },
        { t: a.passed, c: "num" },
        a.partial || "-",
        { t: a.rounds, c: "num" },
        { t: fmtK(a.prompt_tokens), c: "num" },
        { t: a.cached_pct === null ? "-" : a.cached_pct + "%", c: "num" },
        { t: fmtK(a.output_tokens), c: "num" },
        { t: fmtK(a.peak_ctx), c: "num" },
        { t: a.tools, c: "num" },
        { t: a.errors, c: "num" + (a.errors ? " err" : "") },
        { t: a.probes, c: "num" },
        { t: fmtDur(a.wall_secs), c: "num" }
      ];
    });
    wrap.appendChild(table([
      "agent", { label: "cells done", num: true }, { label: "running", num: true },
      { label: "passed", num: true }, "partial", { label: "rounds", num: true },
      { label: "prompt", num: true }, { label: "cached%", num: true },
      { label: "output", num: true }, { label: "peak ctx", num: true },
      { label: "tools", num: true }, { label: "errors", num: true },
      { label: "probes", num: true }, { label: "total wall", num: true }
    ], rows));
  }

  function renderCells(d) {
    var wrap = document.getElementById("cells-wrap");
    var sel = document.getElementById("cell-sort");
    var mode = sel.value;
    clear(wrap);
    var rows = d.matrix.slice();
    rows.sort(function (x, y) {
      if (mode === "task") {
        return x.task === y.task ? x.agent.localeCompare(y.agent) : x.task.localeCompare(y.task);
      }
      return (y[mode] || 0) - (x[mode] || 0);
    });
    var trs = rows.map(function (m) {
      var status = el("span");
      status.appendChild(stateTag(m));
      return [
        m.agent, m.task,
        { child: status },
        m.reward === null || m.reward === undefined ? "-" : m.reward,
        m.partial || "-",
        { t: m.wall_secs === null ? "-" : m.wall_secs, c: "num" },
        { t: m.rounds, c: "num" },
        { t: fmtK(m.prompt_tokens), c: "num" },
        { t: m.cached_tokens ? Math.round(100 * m.cached_tokens / m.prompt_tokens) + "%" : "-", c: "num" },
        { t: fmtK(m.peak_ctx), c: "num" },
        { t: fmtK(m.output_tokens), c: "num" },
        { t: m.tools, c: "num" },
        { t: m.errors, c: "num" + (m.errors ? " err" : "") },
        { t: m.probes, c: "num" },
        m.exception || (m.done ? "no" : (m.running ? "running" : "-")),
        { t: m.latest_seq, c: "num" }
      ];
    });
    wrap.appendChild(table([
      "agent", "task", "state", "reward", "partial", { label: "wall s", num: true },
      { label: "rounds", num: true }, { label: "prompt", num: true },
      { label: "cached%", num: true }, { label: "peak ctx", num: true },
      { label: "output", num: true }, { label: "tools", num: true },
      { label: "err", num: true }, { label: "probe", num: true }, "exception",
      { label: "last seq", num: true }
    ], trs));
    document.getElementById("cells-sort-note").textContent =
      "(" + d.matrix.length + " cells, attribution: attempt birthtime)";
  }

  function renderErrors(d) {
    var wrap = document.getElementById("errors-wrap");
    clear(wrap);
    var note = document.getElementById("errors-note");
    var probes = d.matrix.reduce(function (s, m) { return s + m.probes; }, 0);
    var ex = d.errors.excluded || { rows: 0, errors: 0, probes: 0 };
    note.textContent = "(" + d.errors.total + " HTTP >= 400 in the current attempt windows; " +
      probes + " GET probes treated as harness noise; " +
      ex.errors + " error(s) in " + ex.rows + " superseded-attempt row(s) excluded)";
    var byAgent = Object.keys(d.errors.by_agent).map(function (a) {
      return [a, { t: d.errors.by_agent[a], c: "num" + (d.errors.by_agent[a] ? " err" : "") }];
    });
    wrap.appendChild(table(["agent", { label: "errors", num: true }], byAgent));
    if (!d.errors.recent.length) {
      var msg = "no HTTP >= 400 responses inside the current attempt windows";
      if (ex.errors) {
        msg += " (the " + ex.errors + " response(s) with status >= 400 on disk belong to " +
               "superseded attempts: an earlier run of the same agent/task, before the job " +
               "directory was recreated -- excluded to avoid double counting)";
      }
      wrap.appendChild(el("div", "dim", msg));
      return;
    }
    var rows = d.errors.recent.map(function (e) {
      return [
        { t: e.ts_iso || "-", c: "dim" }, e.agent, e.task,
        { t: e.status, c: "num err" }, e.method + " " + (e.path || ""),
        { t: e.seq, c: "num" },
        e.proxy_error ? "proxy_error" : "http " + e.status
      ];
    });
    var head = el("div", "muted");
    head.style.margin = "10px 0 4px";
    head.textContent = "most recent " + d.errors.recent.length + " errors";
    wrap.appendChild(head);
    wrap.appendChild(table(["ts", "agent", "task", { label: "status", num: true },
                            "request", { label: "seq", num: true }, "kind"], rows));
  }

  function renderSources(d) {
    var wrap = document.getElementById("sources-wrap");
    clear(wrap);
    var s = d.sources, p = d.progress;
    var lines = [
      ["run tag", d.tag],
      ["bench dir", d.bench_dir],
      ["agents", d.agents.join(", ")],
      ["tasks", d.tasks.length + " (" + d.tasks.join(", ") + ")"],
      ["start file", s.started_file + (p.started_at ? " -> " + p.started_at_iso : " (missing)")],
      ["events log", s.events_path + "  (" + s.events_rows + " rows, " + s.events_rows_in_window + " inside current attempt windows)"],
      ["status.tsv", s.status_rows + " rows; " + s.backfilled_cells + " cell(s) recovered from harbor-jobs because status.tsv had no row"],
      ["cell attribution", s.attribution + "; requests before a cell's window belong to a superseded attempt and are excluded"],
      ["excluded rows", s.excluded_rows + " request(s) logged before their cell's current attempt window (" + s.excluded_errors + " of them had status >= 400 -- e.g. the opencode 400s and codex GET 405 probes from the first run of those cells)"],
      ["state rules", "pass = reward 1; timeout = exception name contains Timeout; stalled = no verdict and heartbeat older than " + p.stale_secs + "s; pending = no verdict, no live process"],
      ["rounds", "POST requests seen by the proxy; GET probes counted separately (codex GET /responses -> 405)"]
    ];
    var t = el("table");
    lines.forEach(function (l) {
      var tr = el("tr");
      var a = el("td", "dim"); a.textContent = l[0]; a.style.width = "150px"; a.style.verticalAlign = "top";
      var b = el("td"); b.textContent = l[1];
      tr.appendChild(a); tr.appendChild(b); t.appendChild(tr);
    });
    wrap.appendChild(t);
    var dis = el("div", "muted");
    dis.style.marginTop = "8px";
    dis.textContent = "read-only: this dashboard only reads files / runs `ps`; it never writes outside its own directory.";
    wrap.appendChild(dis);
  }

  function render(d) {
    state.data = d;
    document.getElementById("tag").textContent = d.tag;
    document.getElementById("stamp").textContent = "updated " + d.generated_at_local +
      " (" + d.generated_at_iso + ")";
    var p = d.progress;
    document.getElementById("pills").textContent =
      (p.scheduler_running ? "scheduler running" : "scheduler not in ps") +
      " \u00b7 " + p.running + " live \u00b7 " + p.done + "/" + p.total + " done" +
      " \u00b7 concurrency " + p.concurrency;
    renderProgress(d);
    renderMatrix(d);
    renderLive(d);
    renderTotals(d);
    renderCells(d);
    renderErrors(d);
    renderSources(d);
  }

  function fail(msg) {
    state.failures++;
    document.getElementById("stamp").textContent = "fetch failed (" + state.failures + "): " + msg;
  }

  function tick() {
    var auto = document.getElementById("auto").checked;
    var left = Math.max(0, Math.round((state.next - Date.now()) / 1000));
    document.getElementById("tick").textContent = auto ? "next in " + left + "s" : "paused";
  }

  function load() {
    fetch("/api/data", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (d) { render(d); state.next = Date.now() + 5000; })
      .catch(function (e) { fail(e.message || String(e)); state.next = Date.now() + 5000; });
  }

  setInterval(function () {
    tick();
    if (document.getElementById("auto").checked && Date.now() >= state.next) load();
  }, 500);
  document.getElementById("cell-sort").addEventListener("change", function () {
    if (state.data) renderCells(state.data);
  });
  load();
})();
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "mica-bench-dashboard/1.0"
    cfg: dict = {}

    def log_message(self, fmt, *args):  # keep the console quiet
        pass

    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")
            return
        if path == "/health":
            self._send(200, json.dumps({"ok": True, "pid": os.getpid()}).encode(),
                       "application/json")
            return
        if path == "/api/data":
            try:
                payload = build_payload(self.cfg)
                body = json.dumps(payload).encode("utf-8")
                self._send(200, body, "application/json")
            except Exception as exc:  # keep the page alive and tell it why
                body = json.dumps({"error": f"{type(exc).__name__}: {exc}"}).encode()
                self._send(500, body, "application/json")
            return
        self._send(404, b'{"error":"not found"}', "application/json")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="read-only web dashboard for a mica-bench matrix")
    ap.add_argument("--tag", default=None, help="run tag (default: newest runs/<tag>)")
    ap.add_argument("--tasks", default=None, help="comma separated (default: tasks.txt)")
    ap.add_argument("--agents", default=None, help=f"comma separated (default: {DEFAULT_AGENTS})")
    ap.add_argument("--bench-dir", default=None, help="benchmark home (default: ~/mica-bench)")
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--concurrency", type=int, default=5, help="scheduler parallelism, for ETA")
    ap.add_argument("--stale-secs", type=int, default=STALE_HEARTBEAT_SECS)
    ap.add_argument("--dump", action="store_true", help="print the JSON payload and exit")
    args = ap.parse_args(argv)

    cfg = {
        "bench": find_bench_dir(args.bench_dir),
        "tag": args.tag,
        "tasks": args.tasks,
        "agents": args.agents,
        "concurrency": args.concurrency,
        "stale_secs": args.stale_secs,
    }

    if args.dump:
        payload = build_payload(cfg)
        json.dump(payload, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    Handler.cfg = cfg
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    url = f"http://{args.host}:{args.port}/"
    print(f"[dashboard] tag={cfg['tag'] or detect_tag(cfg['bench'])} bench={cfg['bench']}", flush=True)
    print(f"[dashboard] serving {url}  (read-only; ctrl-c to stop)", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("[dashboard] stopped", flush=True)
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
