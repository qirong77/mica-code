#!/usr/bin/env python3
"""
Render a markdown report for a benchmark matrix.

usage:
  report.py <tag> --cells 40        # render once (interim)
  report.py <tag> --cells 40 --wait # block until the matrix is done, then render
"""
import argparse
import csv
import glob
import json
import os
import subprocess
import sys
import time
from collections import defaultdict

HOME = os.path.expanduser("~")
RUNS = f"{HOME}/mica-bench/runs"
JOBS = f"{HOME}/mica-bench/harbor-jobs"


def read_status(tag):
    p = f"{RUNS}/{tag}/status.tsv"
    rows = []
    seen = set()
    if os.path.exists(p):
        for line in open(p):
            parts = line.rstrip("\n").split("\t")
            if len(parts) == 6:
                rows.append(dict(zip(["agent", "task", "rc", "reward", "wall", "status"], parts)))
                seen.add((parts[0], parts[1]))
    # Backfill from the job dirs.  status.tsv is only a convenience cache: a cell
    # can finish without ever appending a row (scheduler killed mid-write, or the
    # cell script rewritten while an instance was running -- bash reads its script
    # lazily by byte offset, so that corrupts in-flight cells).  The trial's own
    # output on disk is the source of truth, so recover any cell missing from the
    # cache rather than silently under-reporting the matrix.
    for d in sorted(glob.glob(f"{JOBS}/{tag}__*__*")):
        rest = os.path.basename(d)[len(tag) + 2:]
        if "__" not in rest:
            continue
        agent, task = rest.split("__", 1)
        if (agent, task) in seen:
            continue
        rew = reward_of(tag, agent, task)
        exc = bool(glob.glob(f"{d}/*/exception.txt"))
        if rew is None and not exc:
            continue  # still running, or killed before a verdict
        rows.append(dict(agent=agent, task=task, rc="0",
                         reward=str(rew) if rew is not None else "NA",
                         wall="0", status="exception" if exc and rew is None else "ok"))
        seen.add((agent, task))
    return rows


def read_cells():
    sys.path.insert(0, f"{HOME}/mica-bench")
    import collect
    return collect.collect


def scheduler_alive(tag):
    """True while the matrix runner (or one of its cells) for <tag> is still running."""
    try:
        out = subprocess.run(
            ["pgrep", "-f", f"bench-run[0-9]*\\.sh {tag}|cell[0-9]*\\.sh {tag}"],
            capture_output=True, text=True, timeout=20).stdout.strip()
        return bool(out)
    except Exception:
        return True  # on doubt, keep waiting


def reward_of(tag, agent, task):
    d = f"{JOBS}/{tag}__{agent}__{task}"
    for p in glob.glob(f"{d}/*/verifier/reward.txt"):
        try:
            return open(p).read().strip()
        except Exception:
            pass
    return None


def ctrf_of(tag, agent, task):
    d = f"{JOBS}/{tag}__{agent}__{task}"
    for p in glob.glob(f"{d}/*/verifier/ctrf.json"):
        try:
            r = json.load(open(p)).get("results", {})
            s = r.get("summary", {})
            return s.get("passed"), s.get("failed")
        except Exception:
            pass
    return None, None


def phase_of(tag, agent, task):
    d = f"{JOBS}/{tag}__{agent}__{task}"
    for p in glob.glob(f"{d}/*/result.json"):
        try:
            j = json.load(open(p))
        except Exception:
            continue
        def sec(a, b):
            from datetime import datetime
            if not a or not b:
                return None
            try:
                return round((datetime.fromisoformat(b[:19]) - datetime.fromisoformat(a[:19])).total_seconds())
            except Exception:
                return None
        return (sec((j.get("agent_setup") or {}).get("started_at"), (j.get("agent_setup") or {}).get("finished_at")),
                sec((j.get("agent_execution") or {}).get("started_at"), (j.get("agent_execution") or {}).get("finished_at")),
                sec((j.get("verifier") or {}).get("started_at"), (j.get("verifier") or {}).get("finished_at")),
                bool(j.get("exception_info")))
    return (None, None, None, None)


def exception_of(tag, agent, task):
    """Short exception label, e.g. `AgentTimeoutError`.

    A reward of 0 means very different things depending on this: an agent that
    ran out of its 1 h budget never got to finish, whereas one that ran to
    completion and still scored 0 genuinely failed.  `exception.txt` is written
    as soon as the agent phase raises, so fall back to its last traceback line.
    """
    d = f"{JOBS}/{tag}__{agent}__{task}"
    for p in glob.glob(f"{d}/*/result.json"):
        try:
            info = json.load(open(p)).get("exception_info") or {}
            if info.get("exception_type"):
                return info["exception_type"]
        except Exception:
            pass
    for p in glob.glob(f"{d}/*/exception.txt"):
        try:
            lines = [l.strip() for l in open(p) if l.strip()]
            for l in reversed(lines):
                if "Error" in l or "Exception" in l or "Timeout" in l:
                    return l.split(":")[0][-40:]
        except Exception:
            pass
    return None


def cell_since(tag, agent, task):
    """When the cell's *current* attempt started, as epoch seconds.

    The proxy log is a single append-only stream and a re-run reuses the same
    URL tag (`/agent_bench/<agent>/task=<task>`), so filtering by (agent, task)
    alone would merge a re-run with the attempt it replaced -- e.g. opencode's
    pre-fix cells with their post-fix re-runs.  Every attempt wipes and
    recreates its job directory, so the newest trial dir bounds the current
    attempt.

    Use the trial directory's *birth time*, not its oldest file mtime: files
    collected back from the container keep their image build mtimes, so a
    task-baked artifact (e.g. data-anonymization's `policy.yaml`, dated a month
    before the run) makes an "oldest file wins" boundary jump a month into the
    past and silently merges every earlier attempt into this one.
    """
    d = f"{JOBS}/{tag}__{agent}__{task}"
    best, newest = 0, None
    for t in glob.glob(f"{d}/*"):
        try:
            st = os.stat(t)
        except OSError:
            continue
        born = getattr(st, "st_birthtime", None) or st.st_ctime
        if born > best:
            best, newest = born, born
    return newest


def proxy_rows(since=None, since_by_cell=None):
    cells = defaultdict(lambda: {"reqs": 0, "err": 0, "probe": 0, "prompt": 0, "cached": 0, "out": 0, "peak": 0, "tools": 0})
    # codex probes `GET /responses` and gets 405; that is harness noise, not a
    # failed model request, so it is counted separately from real POST errors.
    def is_probe(r):
        return (r.get("method") or "POST").upper() == "GET"
    p = f"{HOME}/mica-bench/events.jsonl"
    if not os.path.exists(p):
        return cells
    for line in open(p, encoding="utf-8"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        cutoff = (since_by_cell or {}).get((r.get("agent"), r.get("task")), since)
        if cutoff and r.get("ts", 0) < cutoff:
            continue
        c = cells[(r.get("agent"), r.get("task"))]
        if is_probe(r):
            c["probe"] += 1
        else:
            c["reqs"] += 1
            if (r.get("status") or 0) >= 400 or r.get("proxy_error"):
                c["err"] += 1
        c["tools"] += r.get("tool_calls") or 0
        u = r.get("usage") or {}
        if u.get("input") is not None:
            c["prompt"] += u["input"]
            c["cached"] += u.get("cached") or 0
            c["out"] += u.get("output") or 0
            c["peak"] = max(c["peak"], u["input"])
    return cells


def k(n, suffix=""):
    if n is None:
        return "-"
    if n >= 1_000_000:
        return f"{n/1_000_000:.2f}M{suffix}"
    if n >= 1_000:
        return f"{n/1_000:.1f}K{suffix}"
    return f"{n}{suffix}"


def render(tag, tasks, agents, since=None):
    status = read_status(tag)
    done = {(r["agent"], r["task"]): r for r in status}
    # per-cell windows win over the global one: a re-run replaces an earlier
    # attempt of the same (agent, task), and its proxy rows must not be merged
    since_by_cell = {(a, t): cell_since(tag, a, t) for t in tasks for a in agents}
    px = proxy_rows(since, since_by_cell)

    out = [f"# Benchmark matrix `{tag}`", ""]
    out.append(f"- cells reported: **{len(status)}** / {len(tasks)*len(agents)}")
    out.append(f"- agents: {', '.join(agents)}")
    out.append(f"- tasks: {', '.join(tasks)}")
    if since:
        out.append(f"- proxy window: requests after {time.strftime('%Y-%m-%d %H:%M:%SZ', time.gmtime(since))}")
    out.append("")

    out.append("## Per-cell results")
    out.append("")
    out.append("| agent | task | reward | partial | setup | exec | verify | wall | rounds | prompt | cached% | peak ctx | output | tools | err | probe | exc |")
    out.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for t in tasks:
        for a in agents:
            r = done.get((a, t))
            rew = reward_of(tag, a, t) if r else None
            pp, pf = ctrf_of(tag, a, t) if r else (None, None)
            su, ex, ve, exc = phase_of(tag, a, t) if r else (None, None, None, None)
            exc_name = exception_of(tag, a, t) if r else None
            c = px.get((a, t), {})
            part = f"{pp}/{pp+pf}" if pp is not None and pf is not None else "-"
            cpct = f"{100.0*c['cached']/c['prompt']:.0f}%" if c.get("prompt") else "-"
            # a backfilled cell has no status row, hence no recorded wall time;
            # the trial's own phase timings are the next best thing
            wall = int(r["wall"]) if r and r.get("wall", "0") not in ("", "0") else \
                (su or 0) + (ex or 0) + (ve or 0)
            out.append("| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |".format(
                a, t, rew if rew is not None else ("-" if r else "pending"), part,
                su if su is not None else "-", ex if ex is not None else "-",
                ve if ve is not None else "-", (str(wall) + "s") if r else "-",
                c.get("reqs", "-"), k(c.get("prompt")), cpct, k(c.get("peak")),
                k(c.get("out")), c.get("tools", "-"), c.get("err", "-"),
                c.get("probe", 0),
                exc_name if exc_name else ("no" if exc is False else "-")))
    out.append("")

    agg = defaultdict(lambda: {"n": 0, "pass": 0, "pp": 0, "pf": 0, "prompt": 0, "cached": 0,
                               "out": 0, "rounds": 0, "tools": 0, "peak": 0, "err": 0, "probe": 0, "wall": 0})
    for t in tasks:
        for a in agents:
            r = done.get((a, t))
            g = agg[a]
            g["n"] += 1
            if r:
                g["wall"] += int(r["wall"])
                if r["reward"] == "1":
                    g["pass"] += 1
            pp, pf = ctrf_of(tag, a, t) if r else (None, None)
            if pp is not None:
                g["pp"] += pp
                g["pf"] += pf or 0
            c = px.get((a, t), {})
            g["prompt"] += c.get("prompt", 0)
            g["cached"] += c.get("cached", 0)
            g["out"] += c.get("out", 0)
            g["rounds"] += c.get("reqs", 0)
            g["tools"] += c.get("tools", 0)
            g["peak"] = max(g["peak"], c.get("peak", 0))
            g["err"] += c.get("err", 0)
            g["probe"] += c.get("probe", 0)

    out.append("## Per-agent totals")
    out.append("")
    out.append("| agent | cells done | passed | partial | rounds | prompt | cached% | output | peak ctx | tools | errors | probes | total wall |")
    out.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for a in agents:
        g = agg[a]
        part = f"{g['pp']}/{g['pp']+g['pf']}" if (g["pp"] or g["pf"]) else "-"
        cpct = f"{100.0*g['cached']/g['prompt']:.0f}%" if g["prompt"] else "-"
        out.append("| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {}s |".format(
            a, g["n"], g["pass"], part, g["rounds"], k(g["prompt"]), cpct,
            k(g["out"]), k(g["peak"]), g["tools"], g["err"], g["probe"], g["wall"]))
    out.append("")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tag")
    ap.add_argument("--cells", type=int, default=0)
    ap.add_argument("--tasks", required=True)
    ap.add_argument("--agents", default="mica,codex,opencode,kimi-code")
    ap.add_argument("--wait", action="store_true")
    ap.add_argument("--since", type=float, default=None)
    args = ap.parse_args()

    tasks = args.tasks.split(",")
    agents = args.agents.split(",")

    if args.wait:
        target = args.cells or len(tasks) * len(agents)
        # Block until the matrix is done -- but never wait forever: if the
        # scheduler itself died (it has happened: a full host disk killed the
        # whole VM mid-run) we would sit here all night and never render a
        # report.  Treat "scheduler gone AND no progress" as done.
        idle = 0
        deadline = time.time() + 11 * 3600
        while time.time() < deadline:
            n = len(read_status(args.tag))
            if n >= target:
                break
            if scheduler_alive(args.tag):
                idle = 0
            else:
                idle += 1
                if idle >= 3:
                    print(f"[report] scheduler gone with {n}/{target} cells recorded; rendering partial report")
                    break
            time.sleep(60)
        time.sleep(30)

    since = args.since
    if since is None:
        p = f"{HOME}/mica-bench/{args.tag}.started"
        if os.path.exists(p):
            from datetime import datetime
            try:
                since = datetime.fromisoformat(open(p).read().strip().replace("Z", "+00:00")).timestamp()
            except Exception:
                pass

    md = render(args.tag, tasks, agents, since)
    outp = f"{RUNS}/{args.tag}/REPORT.md"
    os.makedirs(os.path.dirname(outp), exist_ok=True)
    open(outp, "w", encoding="utf-8").write(md)
    print(md)
    print(f"\nwrote {outp}")


if __name__ == "__main__":
    main()
