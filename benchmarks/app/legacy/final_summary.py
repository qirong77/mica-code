#!/usr/bin/env python3
"""Final cross-agent comparison for the reg2 benchmark matrix.

Authoritative sources (per the runbook):
  * tokens / rounds  -> the local proxy log (events.jsonl), attributed to the
    *current* attempt of each agent x task via the attempt dir's birthtime.
  * reward / partial / phase timings -> harbor's per-trial result.json + ctrf.json.

Cells that were killed mid-run (no reward.txt and no exception.txt) are reported
as INCOMPLETE and excluded from all aggregates.
"""

import glob
import json
import os
import subprocess
import sys
from collections import defaultdict

HOME = os.path.expanduser("~")
BENCH = os.path.join(HOME, "mica-bench")
TAG = sys.argv[1] if len(sys.argv) > 1 else "reg2"

AGENTS = ["mica", "codex", "opencode", "kimi-code"]


def birthtime(path):
    """Attempt window start. MUST be the dir's birthtime.

    Files collected out of containers keep their image-build mtime (often weeks
    old), so min(mtime) would drag the window back and merge re-runs together.
    """
    try:
        out = subprocess.run(
            ["stat", "-f", "%B", path], capture_output=True, text=True, timeout=10
        ).stdout.strip()
        return float(out)
    except Exception:
        return None


def load_events():
    path = os.path.join(BENCH, "events.jsonl")
    rows = []
    with open(path, errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def attempt_dirs(agent, task):
    pat = os.path.join(BENCH, "harbor-jobs", f"{TAG}__{agent}__{task}", "*")
    out = []
    for d in glob.glob(pat):
        if os.path.isdir(d):
            bt = birthtime(d)
            if bt is not None:
                out.append((bt, d))
    out.sort()
    return out


def read_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None


def collect_cell(agent, task):
    """Newest attempt only -> the result we report."""
    dirs = attempt_dirs(agent, task)
    if not dirs:
        return None
    bt, d = dirs[-1]

    reward = None
    rp = os.path.join(d, "verifier", "reward.txt")
    if os.path.exists(rp):
        raw = open(rp, errors="replace").read().strip()
        try:
            reward = int(float(raw))
        except ValueError:
            reward = None

    partial = None
    ctrf = read_json(os.path.join(d, "verifier", "ctrf.json"))
    if ctrf:
        try:
            s = ctrf["results"]["summary"]
            p, f = int(s.get("passed", 0)), int(s.get("failed", 0))
            if p + f:
                partial = (p, p + f)
        except Exception:
            pass

    # fall back to the verifier stdout when there is no ctrf (pytest/unittest)
    if partial is None:
        so = os.path.join(d, "verifier", "test-stdout.txt")
        if os.path.exists(so):
            txt = open(so, errors="replace").read()
            import re
            m = re.search(r"(\d+) passed", txt)
            if m:
                passed = int(m.group(1))
                failed = 0
                mf = re.search(r"(\d+) failed", txt)
                if mf:
                    failed = int(mf.group(1))
                if passed + failed:
                    partial = (passed, passed + failed)

    res = read_json(os.path.join(d, "result.json")) or {}
    exc = (res.get("exception_info") or {}).get("exception_type")
    phases = {}
    for key in ("agent_setup", "agent_execution", "verifier", "environment_setup"):
        blk = res.get(key) or {}
        a, b = blk.get("started_at"), blk.get("finished_at")
        if a and b:
            try:
                from datetime import datetime
                pa = datetime.fromisoformat(a.replace("Z", "+00:00"))
                pb = datetime.fromisoformat(b.replace("Z", "+00:00"))
                phases[key] = (pb - pa).total_seconds()
            except Exception:
                pass

    har = res.get("agent_result") or {}
    # result.json is harbor's authoritative "this trial was finalized" marker.
    # reward.txt alone is not enough: a verifier killed mid-run can leave a
    # reward=0 behind (observed: kimi-code/embedding-drift-monitor), which is
    # not a real verdict.
    done = bool(res) and (os.path.exists(rp) or os.path.exists(os.path.join(d, "exception.txt")))

    return {
        "agent": agent,
        "task": task,
        "dir": d,
        "birth": bt,
        "reward": reward,
        "partial": partial,
        "exception": exc,
        "phases": phases,
        "harbor_in": har.get("n_input_tokens"),
        "harbor_cache": har.get("n_cache_tokens"),
        "harbor_out": har.get("n_output_tokens"),
        "complete": done,
        "attempts": len(dirs),
    }


def attribute_events(events, cell):
    """Sum the proxy log over [attempt birth, +inf). Superseded attempts of the
    same agent x task fall outside this window and are excluded."""
    lo = cell["birth"]
    hi = cell["birth"] + 6 * 3600 + 600  # generous clamp; single cell <= 1h
    agg = {
        "rounds": 0, "input": 0, "cached": 0, "output": 0, "reasoning": 0,
        "errors": 0, "probes": 0, "peak_ctx": 0, "statuses": defaultdict(int),
        "tools": defaultdict(int), "first": None, "last": None, "ttfb": [],
    }
    for e in events:
        if e.get("agent") != cell["agent"] or e.get("task") != cell["task"]:
            continue
        ts = e.get("ts")
        if not isinstance(ts, (int, float)) or not (lo <= ts <= hi):
            continue
        agg["rounds"] += 1
        st = e.get("status")
        if isinstance(st, int):
            agg["statuses"][st] += 1
            if st >= 400:
                path = (e.get("upstream_path") or "").strip("/")
                if e.get("method") == "GET" and path in ("responses", "models", ""):
                    agg["probes"] += 1
                else:
                    agg["errors"] += 1
        u = e.get("usage") or {}
        if isinstance(u, dict):
            agg["input"] += int(u.get("input") or 0)
            agg["cached"] += int(u.get("cached") or 0)
            agg["output"] += int(u.get("output") or 0)
            agg["reasoning"] += int(u.get("reasoning") or 0)
            agg["peak_ctx"] = max(agg["peak_ctx"], int(u.get("input") or 0))
        for t in e.get("tool_names") or []:
            if isinstance(t, str):
                agg["tools"][t] += 1
        if isinstance(e.get("ttfb_ms"), (int, float)):
            agg["ttfb"].append(e["ttfb_ms"])
        if agg["first"] is None or ts < agg["first"]:
            agg["first"] = ts
        if agg["last"] is None or ts > agg["last"]:
            agg["last"] = ts
    return agg


def fmt(n):
    if n is None:
        return "-"
    n = int(n)
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}K"
    return str(n)


def main():
    tasks = [t.strip() for t in open(os.path.join(BENCH, "tasks.txt")).read().split(",") if t.strip()]
    events = load_events()
    print(f"proxy log: {len(events)} requests\n")

    cells = []
    for task in tasks:
        for agent in AGENTS:
            c = collect_cell(agent, task)
            if c is None:
                c = {"agent": agent, "task": task, "complete": False, "reward": None,
                     "partial": None, "exception": None, "phases": {}, "birth": None,
                     "harbor_in": None, "harbor_cache": None, "harbor_out": None,
                     "attempts": 0, "dir": None}
                cells.append(c)
                continue
            if c["complete"]:
                c["agg"] = attribute_events(events, c)
            cells.append(c)

    # ---------------- per-cell table ----------------
    print("=" * 150)
    print("PER-CELL")
    print("=" * 150)
    hdr = f"{'agent':<10} {'task':<24} {'rew':>4} {'partial':>8} {'wall':>6} {'setup':>6} {'exec':>6} {'verify':>7} {'rounds':>7} {'prompt':>8} {'cache%':>7} {'out':>7} {'err':>4} {'exc':<26}"
    print(hdr)
    print("-" * 150)
    for c in sorted(cells, key=lambda x: (x["task"], AGENTS.index(x["agent"]))):
        if not c.get("birth"):
            print(f"{c['agent']:<10} {c['task']:<24} {'-':>4} {'not run':>8}")
            continue
        p = c["phases"]
        wall = sum(p.values()) if p else None
        pr = f"{c['partial'][0]}/{c['partial'][1]}" if c["partial"] else "-"
        a = c.get("agg") or {}
        cb = (a.get("cached", 0) / a["input"] * 100) if a.get("input") else None
        mark = "" if c["complete"] else "  [INCOMPLETE]"
        print(f"{c['agent']:<10} {c['task']:<24} "
              f"{str(c['reward']) if c['reward'] is not None else '-':>4} {pr:>8} "
              f"{int(wall) if wall else '-':>6} "
              f"{int(p.get('agent_setup', 0)):>6} {int(p.get('agent_execution', 0)):>6} "
              f"{int(p.get('verifier', 0)):>7} "
              f"{a.get('rounds', '-'):>7} {fmt(a.get('input')):>8} "
              f"{f'{cb:.0f}%' if cb else '-':>7} {fmt(a.get('output')):>7} "
              f"{a.get('errors', '-'):>4} {str(c['exception'] or '')[:26]:<26}{mark}")

    done = [c for c in cells if c.get("birth") and c["complete"]]
    print(f"\ncomplete cells: {len(done)} / {len(cells)}")

    # ---------------- per agent ----------------
    print("\n" + "=" * 150)
    print("PER-AGENT  (complete cells only)")
    print("=" * 150)
    print(f"{'agent':<12} {'n':>3} {'pass':>5} {'mean%':>7} {'wtd%':>7} {'rounds':>7} {'prompt':>9} {'cache%':>7} {'out':>8} {'wall_sum':>9} {'walls':>6} {'err':>4} {'t/o':>5}")
    print("-" * 150)
    agg_agent = {}
    for agent in AGENTS:
        cs = [c for c in done if c["agent"] == agent]
        if not cs:
            continue
        passes = sum(1 for c in cs if c["reward"] == 1)
        pp = [c["partial"] for c in cs if c["partial"]]
        num = sum(p for p, t in pp)
        den = sum(t for p, t in pp)
        # Unweighted mean of per-cell pass rates. The test-count-weighted figure
        # is dominated by wal-recovery-ordering (97 tests) and would swamp the
        # signal from 2-test tasks like html-js-filter.
        rates = [p / t for p, t in pp if t]
        mean_rate = sum(rates) / len(rates) if rates else None
        rounds = sum(c["agg"]["rounds"] for c in cs)
        inp = sum(c["agg"]["input"] for c in cs)
        cac = sum(c["agg"]["cached"] for c in cs)
        out = sum(c["agg"]["output"] for c in cs)
        wall = sum(sum(c["phases"].values()) for c in cs if c["phases"])
        errs = sum(c["agg"]["errors"] for c in cs)
        tos = sum(1 for c in cs if (c["exception"] or "").lower().find("timeout") >= 0)
        agg_agent[agent] = dict(n=len(cs), passes=passes, num=num, den=den,
                                rounds=rounds, inp=inp, cac=cac, out=out,
                                wall=wall, errs=errs, timeouts=tos,
                                mean_rate=mean_rate,
                                tasks=[c["task"] for c in cs])
        print(f"{agent:<12} {len(cs):>3} {passes:>5} "
              f"{f'{mean_rate*100:.1f}%' if mean_rate is not None else '-':>7} "
              f"{f'{num/den*100:.1f}%' if den else '-':>7} "
              f"{rounds:>7} {fmt(inp):>9} "
              f"{f'{cac/inp*100:.1f}%' if inp else '-':>7} {fmt(out):>8} "
              f"{wall:>9.0f} {wall/len(cs):>6.0f} {errs:>4} {tos:>5}")

    # ---------------- per task ----------------
    print("\n" + "=" * 150)
    print("PER-TASK  (complete cells only)")
    print("=" * 150)
    print(f"{'task':<24} " + " ".join(f"{a[:9]:>11}" for a in AGENTS))
    print("-" * 150)
    for task in tasks:
        row = []
        for agent in AGENTS:
            cs = [c for c in done if c["agent"] == agent and c["task"] == task]
            if not cs:
                row.append(f"{'-':>11}")
                continue
            c = cs[0]
            if c["reward"] == 1:
                s = f"PASS {c['partial'][0]}/{c['partial'][1]}" if c["partial"] else "PASS"
            elif c["partial"]:
                s = f"{c['reward']} {c['partial'][0]}/{c['partial'][1]}"
            else:
                s = str(c["reward"])
            row.append(f"{s:>11}")
        print(f"{task:<24} " + " ".join(row))

    # ---------------- fair subset ----------------
    # Cross-agent means above are over unequal task subsets (not every agent
    # finished every task before the run was stopped). Restrict to tasks where
    # ALL agents have a complete cell -> the only apples-to-apples comparison.
    common = [t for t in tasks
              if all(any(c["agent"] == a and c["task"] == t for c in done) for a in AGENTS)]
    if common:
        print("\n" + "=" * 150)
        print(f"FAIR SUBSET - tasks all {len(AGENTS)} agents completed ({', '.join(common)})")
        print("=" * 150)
        print(f"{'agent':<12} {'cells':>6} {'mean%':>7} {'pass':>5} {'rounds':>7} {'prompt':>9} {'out':>8}")
        print("-" * 150)
        for agent in AGENTS:
            cs = [c for c in done if c["agent"] == agent and c["task"] in common]
            rates = [p / t for c in cs if c["partial"] for p, t in [c["partial"]] if t]
            if not cs:
                continue
            mr = sum(rates) / len(rates) if rates else None
            print(f"{agent:<12} {len(cs):>6} "
                  f"{f'{mr*100:.1f}%' if mr is not None else '-':>7} "
                  f"{sum(1 for c in cs if c['reward'] == 1):>5} "
                  f"{sum(c['agg']['rounds'] for c in cs):>7} "
                  f"{fmt(sum(c['agg']['input'] for c in cs)):>9} "
                  f"{fmt(sum(c['agg']['output'] for c in cs)):>8}")

    # ---------------- tools ----------------
    print("\n" + "=" * 150)
    print("TOOL MIX (share of tool calls, complete cells)")
    print("=" * 150)
    for agent in AGENTS:
        cs = [c for c in done if c["agent"] == agent]
        tot = defaultdict(int)
        for c in cs:
            for k, v in c["agg"]["tools"].items():
                tot[k] += v
        n = sum(tot.values())
        if not n:
            print(f"{agent:<12} (no tool data)")
            continue
        top = sorted(tot.items(), key=lambda kv: -kv[1])[:8]
        print(f"{agent:<12} " + "  ".join(f"{k}:{v/n*100:.0f}%" for k, v in top))

    # ---------------- exceptions ----------------
    print("\n" + "=" * 150)
    print("NON-ZERO EXITS / EXCEPTIONS (complete cells)")
    print("=" * 150)
    for agent in AGENTS:
        cs = [c for c in done if c["agent"] == agent and c["exception"]]
        if not cs:
            continue
        for c in cs:
            print(f"  {agent:<12} {c['task']:<24} {c['exception']:<30} reward={c['reward']} partial={c['partial']}")


if __name__ == "__main__":
    main()
