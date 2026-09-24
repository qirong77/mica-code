#!/usr/bin/env python3
"""
Collect every measurable per-cell fact into one table.

Two independent sources are joined on the (agent, task) cell id:

  harbor   -- phase timings (environment/setup/execution/verifier), reward,
              exception, and the agent's own usage counters
  proxy    -- what the model API actually saw (tokens, cache, rounds, tools)

The proxy numbers are the ones to trust for usage; the harbor numbers are the
ones to trust for wall clock and reward.

usage:  collect.py <run-tag> [--prefix <job-dir-prefix>]
        collect.py --all
"""
import argparse
import csv
import glob
import json
import os
from datetime import datetime

JOBS = os.path.expanduser("~/mica-bench/harbor-jobs")
RUNS = os.path.expanduser("~/mica-bench/runs")
EVENTS = os.path.expanduser("~/mica-bench/events.jsonl")


def secs(a, b):
    if not a or not b:
        return None
    try:
        return round((datetime.fromisoformat(b[:19]) - datetime.fromisoformat(a[:19])).total_seconds())
    except Exception:
        return None


def cell_id(job_name):
    """<tag>__<agent>__<task> -> (tag, agent, task)."""
    parts = job_name.split("__")
    if len(parts) >= 3:
        return parts[0], parts[1], "__".join(parts[2:])
    return None, None, None


def proxy_cells():
    cells = {}
    if not os.path.exists(EVENTS):
        return cells
    with open(EVENTS, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            key = (r.get("agent") or "?", r.get("task") or "-")
            c = cells.setdefault(key, {
                "reqs": 0, "errors": 0, "prompt": 0, "cached": 0, "output": 0,
                "reasoning": 0, "peak_ctx": 0, "tools": 0, "first_ts": None,
                "last_ts": None, "modes": set(),
            })
            c["reqs"] += 1
            if (r.get("status") or 0) >= 400 or r.get("proxy_error"):
                c["errors"] += 1
            ts = r.get("ts")
            if ts:
                c["first_ts"] = ts if c["first_ts"] is None else min(c["first_ts"], ts)
                c["last_ts"] = ts if c["last_ts"] is None else max(c["last_ts"], ts)
            if r.get("mode"):
                c["modes"].add(r["mode"])
            c["tools"] += r.get("tool_calls") or 0
            u = r.get("usage") or {}
            if u.get("input") is not None:
                c["prompt"] += u["input"]
                c["cached"] += u.get("cached") or 0
                c["output"] += u.get("output") or 0
                c["reasoning"] += u.get("reasoning") or 0
                c["peak_ctx"] = max(c["peak_ctx"], u["input"])
    return cells


def ctrf_counts(trial_dir):
    """Partial credit from a CTRF report, when the verifier emits one."""
    passed = failed = None
    for p in glob.glob(os.path.join(trial_dir, "verifier", "**", "*.json"), recursive=True):
        try:
            d = json.load(open(p))
        except Exception:
            continue
        s = (d.get("results") or {}).get("summary") if isinstance(d.get("results"), dict) else d.get("summary")
        if isinstance(s, dict) and ("passed" in s or "failed" in s):
            passed = s.get("passed", passed)
            failed = s.get("failed", failed)
    return passed, failed


def collect(prefixes):
    proxy = proxy_cells()
    rows = []
    for prefix in prefixes:
        for p in glob.glob(os.path.join(JOBS, prefix + "*", "*", "result.json")):
            try:
                d = json.load(open(p))
            except Exception:
                continue
            trial_dir = os.path.dirname(p)
            job_name = os.path.basename(os.path.dirname(trial_dir))
            tag, agent, task = cell_id(job_name)
            ar = d.get("agent_result") or {}
            rewards = (d.get("verifier_result") or {}).get("rewards") or {}
            reward = rewards.get("reward")
            px = proxy.get((agent, task), {})
            passed, failed = ctrf_counts(trial_dir)
            rows.append({
                "tag": tag, "agent": agent, "task": task,
                "reward": reward,
                "partial_pass": passed if passed is not None else "",
                "partial_total": (passed + failed) if (passed is not None and failed is not None) else "",
                "exception": (d.get("exception_info") or {}).get("exception_type", "") if d.get("exception_info") else "",
                "env_setup_s": secs((d.get("environment_setup") or {}).get("started_at"), (d.get("environment_setup") or {}).get("finished_at")),
                "agent_setup_s": secs((d.get("agent_setup") or {}).get("started_at"), (d.get("agent_setup") or {}).get("finished_at")),
                "agent_exec_s": secs((d.get("agent_execution") or {}).get("started_at"), (d.get("agent_execution") or {}).get("finished_at")),
                "verifier_s": secs((d.get("verifier") or {}).get("started_at"), (d.get("verifier") or {}).get("finished_at")),
                "wall_s": secs(d.get("started_at"), d.get("finished_at")),
                "harbor_in": ar.get("n_input_tokens"), "harbor_cache": ar.get("n_cache_tokens"),
                "harbor_out": ar.get("n_output_tokens"),
                "px_reqs": px.get("reqs"), "px_errors": px.get("errors"),
                "px_prompt": px.get("prompt"), "px_cached": px.get("cached"),
                "px_output": px.get("output"), "px_reasoning": px.get("reasoning"),
                "px_peak_ctx": px.get("peak_ctx"), "px_tools": px.get("tools"),
                "px_mode": ",".join(sorted(px.get("modes") or [])) or "",
                "px_wall_s": round(px["last_ts"] - px["first_ts"]) if px.get("first_ts") and px.get("last_ts") else "",
            })
    return rows


COLS = ["tag", "agent", "task", "reward", "partial_pass", "partial_total", "exception",
        "env_setup_s", "agent_setup_s", "agent_exec_s", "verifier_s", "wall_s",
        "harbor_in", "harbor_cache", "harbor_out",
        "px_reqs", "px_errors", "px_prompt", "px_cached", "px_output", "px_reasoning",
        "px_peak_ctx", "px_tools", "px_mode", "px_wall_s"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tags", nargs="*", help="run tags (job prefix, e.g. reg1)")
    ap.add_argument("--all", action="store_true", help="every job dir")
    args = ap.parse_args()

    prefixes = [""] if args.all else [f"{t}__" for t in args.tags]
    rows = collect(prefixes)
    if not rows:
        print("no trials found")
        return 1
    rows.sort(key=lambda r: (r["tag"] or "", r["task"] or "", r["agent"] or ""))

    out = os.path.join(RUNS, (args.tags[0] if args.tags else "all") + ".cells.csv")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLS)
        w.writeheader()
        w.writerows(rows)

    hdr = f"{'agent':<10} {'task':<26} {'rew':>4} {'part':>7} {'setup':>6} {'exec':>6} {'verif':>6} {'wall':>6} {'rounds':>7} {'prompt':>10} {'exec?':>6}"
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        part = f"{r['partial_pass']}/{r['partial_total']}" if r["partial_total"] != "" else "-"
        print(f"{r['agent'] or '?':<10} {r['task'] or '?':<26} {str(r['reward']):>4} {part:>7} "
              f"{str(r['agent_setup_s'] or '-'):>6} {str(r['agent_exec_s'] or '-'):>6} "
              f"{str(r['verifier_s'] or '-'):>6} {str(r['wall_s'] or '-'):>6} "
              f"{str(r['px_reqs'] or '-'):>7} {str(r['px_prompt'] or '-'):>10} "
              f"{str(r['exception'])[:6]:>6}")
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
