#!/usr/bin/env python3
"""
Aggregate the proxy JSONL into per-(agent, task) comparison tables.

The proxy sits in front of the model API, so every number here is what the
provider actually saw -- comparable across agents even when an agent's own
reported usage is wrong or missing (kimi-code reports none).

usage:  summarize.py [--log PATH] [--task ID] [--agent NAME] [--errors]
"""
import argparse
import json
import os
import sys
from collections import defaultdict

DEFAULT_LOG = os.path.expanduser("~/mica-bench/events.jsonl")


def load(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    return rows


def cell_of(r):
    return (r.get("agent") or "?", r.get("task") or "-")


def aggregate(rows):
    cells = defaultdict(lambda: {
        "requests": 0, "errors": 0, "input": 0, "cached": 0, "output": 0,
        "reasoning": 0, "peak_input": 0, "tool_calls": 0, "completed": 0,
        "first_ts": None, "last_ts": None, "ttfb": [], "modes": set(),
        "models": set(), "no_usage": 0, "probes": 0,
    })
    for r in rows:
        c = cells[cell_of(r)]
        st = r.get("status") or 0
        # `GET /responses` 405s are codex harness probes, not failed model calls.
        if (r.get("method") or "POST").upper() == "GET":
            c["probes"] += 1
        else:
            c["requests"] += 1
            if st >= 400 or r.get("proxy_error"):
                c["errors"] += 1
        ts = r.get("ts")
        if ts:
            c["first_ts"] = ts if c["first_ts"] is None else min(c["first_ts"], ts)
            c["last_ts"] = ts if c["last_ts"] is None else max(c["last_ts"], ts)
        if r.get("ttfb_ms"):
            c["ttfb"].append(r["ttfb_ms"])
        if r.get("mode"):
            c["modes"].add(r["mode"])
        if r.get("model"):
            c["models"].add(str(r["model"]))
        u = r.get("usage")
        if isinstance(u, dict) and (u.get("input") is not None or u.get("output") is not None):
            inp = u.get("input") or 0
            c["input"] += inp
            c["cached"] += u.get("cached") or 0
            c["output"] += u.get("output") or 0
            c["reasoning"] += u.get("reasoning") or 0
            c["peak_input"] = max(c["peak_input"], inp)
            c["completed"] += 1
        else:
            c["no_usage"] += 1
        c["tool_calls"] += r.get("tool_calls") or 0
    return cells


def fmt(n):
    if n is None:
        return "-"
    if n >= 1_000_000:
        return f"{n/1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}K"
    return str(n)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", default=DEFAULT_LOG)
    ap.add_argument("--task")
    ap.add_argument("--agent")
    ap.add_argument("--errors", action="store_true", help="dump failing requests")
    args = ap.parse_args()

    if not os.path.exists(args.log):
        print(f"no log at {args.log}", file=sys.stderr)
        return 1
    rows = load(args.log)
    if args.task:
        rows = [r for r in rows if (r.get("task") or "-") == args.task]
    if args.agent:
        rows = [r for r in rows if (r.get("agent") or "?") == args.agent]

    if args.errors:
        for r in rows:
            st = r.get("status") or 0
            if st >= 400 or r.get("proxy_error"):
                print(f"{r.get('agent'):<10} {r.get('task'):<24} #{r.get('seq'):<3} "
                      f"{r.get('method')} {r.get('upstream_path')} -> {st}")
                eb = (r.get("error_body") or r.get("upstream_error") or r.get("proxy_error") or "")
                if eb:
                    print("    ", eb.replace("\n", " ")[:220])
        return 0

    cells = aggregate(rows)
    by_agent = defaultdict(lambda: {"requests": 0, "errors": 0, "input": 0,
                                    "cached": 0, "output": 0, "tasks": 0})

    print(f"# cells: {len(cells)}   requests: {len(rows)}\n")
    hdr = (f"{'agent':<10} {'task':<26} {'req':>4} {'err':>4} {'prompt':>9} "
           f"{'cached%':>8} {'peakCtx':>9} {'output':>8} {'tools':>6} {'wall':>7} {'ttfb':>6}")
    print(hdr)
    print("-" * len(hdr))
    for (agent, task) in sorted(cells):
        c = cells[(agent, task)]
        cached_pct = (100.0 * c["cached"] / c["input"]) if c["input"] else 0.0
        wall = (c["last_ts"] - c["first_ts"]) if (c["first_ts"] and c["last_ts"]) else 0
        ttfb = (sum(c["ttfb"]) / len(c["ttfb"]) / 1000.0) if c["ttfb"] else 0
        print(f"{agent:<10} {task:<26} {c['requests']:>4} {c['errors']:>4} "
              f"{fmt(c['input']):>9} {cached_pct:>7.1f}% {fmt(c['peak_input']):>9} "
              f"{fmt(c['output']):>8} {c['tool_calls']:>6} {wall:>6.0f}s {ttfb:>5.1f}s")
        a = by_agent[agent]
        a["requests"] += c["requests"]; a["errors"] += c["errors"]
        a["input"] += c["input"]; a["cached"] += c["cached"]
        a["output"] += c["output"]; a["tasks"] += 1

    print("\n## per agent")
    hdr2 = f"{'agent':<10} {'tasks':>5} {'req':>5} {'err':>4} {'prompt':>10} {'cached%':>8} {'output':>9}"
    print(hdr2)
    print("-" * len(hdr2))
    for agent in sorted(by_agent):
        a = by_agent[agent]
        pct = (100.0 * a["cached"] / a["input"]) if a["input"] else 0.0
        print(f"{agent:<10} {a['tasks']:>5} {a['requests']:>5} {a['errors']:>4} "
              f"{fmt(a['input']):>10} {pct:>7.1f}% {fmt(a['output']):>9}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
