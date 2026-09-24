"""Read side of the console: the single source of truth for benchmark results.

Replaces the three divergent implementations that used to exist
(``report.py``, ``dashboard.py`` and ``collect.py`` each had their own notion of
"cell is done", "reward" and "attribution window").  Disk is authoritative;
``runs/<tag>/status.tsv`` is only a hint that gets backfilled from the job
directories.

Two rules are easy to get wrong and are therefore stated once, here:

* **Attribution window** -- a cell's proxy rows start at the *birthtime* of its
  newest attempt directory, clamped to now.  Never ``min(mtime)``: files that
  harbor collects out of the container keep the image-build mtime, so ``min``
  drags in every previous attempt (it once inflated one cell from 30 rounds to
  76).
* **Completion** -- a cell has a verdict only when the trial produced a
  ``verifier/reward.txt`` or the job recorded an exception.  A reward.txt written
  mid-verification is *not* a verdict; that is why ``result.json`` is consulted
  first.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from .catalog import JOBS_DIR, list_task_catalog
from .settings import BENCH_DIR, EVENTS_PATH, RUNS_DIR

TIMEOUT_MARKERS = ("timeout", "timedout")


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _iso_epoch(value: str | None) -> float | None:
    if not value:
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        from datetime import datetime

        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None


def _birthtime(path: Path) -> float:
    """Prefer birthtime; it is the only field that does not lie (see module doc)."""
    try:
        st = path.stat()
    except OSError:
        return time.time()
    return float(getattr(st, "st_birthtime", None) or st.st_mtime)


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _trial_dir(job_dir: Path, task: str) -> Path | None:
    """Newest ``<task>__<hash>`` attempt directory inside a job dir."""
    if not job_dir.is_dir():
        return None
    candidates = [
        p
        for p in job_dir.iterdir()
        if p.is_dir() and p.name.startswith(f"{task}__")
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda p: (_mtime(p), p.name))


def attribution_since(job_dir: Path, task: str) -> float | None:
    """Start of the proxy window for a cell: the attempt directory's birthtime.

    Precisely the *attempt directory*, not the newest file under the job dir.
    harbor writes ``result.json`` and the collected artifacts after the agent has
    exited, and those carry a later birthtime than every request the agent made
    -- taking the newest of anything under the job dir therefore parks the window
    after the run and reports 0 rounds for a cell that made 65 requests.
    """
    attempt = _trial_dir(job_dir, task)
    if attempt is None:
        return None
    since = _birthtime(attempt)
    if since <= 0:
        return None
    return min(since, time.time())


# ---------------------------------------------------------------------------
# job directory -> cell record
# ---------------------------------------------------------------------------


@dataclass
class CellRecord:
    agent: str
    task: str
    state: str = "pending"  # pending|running|pass|fail|timeout|exception|stalled
    reward: float | None = None
    partial_passed: int | None = None
    partial_total: int | None = None
    wall_secs: float | None = None
    phases: dict[str, float] = field(default_factory=dict)
    exception: str | None = None
    started_at: float | None = None
    finished_at: float | None = None
    note: str | None = None
    running: bool = False
    pid: int | None = None
    heartbeat_age_secs: float | None = None
    attribution_since: float | None = None
    attempt_dir: str | None = None
    # Per-test detail from the verifier's CTRF report (pytest-based tasks only).
    # Empty for shell-reward verifiers, which report a single binary verdict.
    tests: list[dict[str, object]] = field(default_factory=list)
    # proxy-derived, filled in by the aggregator
    rounds: int = 0
    prompt_tokens: int = 0
    cached_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    tool_calls: int = 0
    peak_ctx: int = 0
    errors: int = 0
    probes: int = 0
    last_request_at: float | None = None

    @property
    def done(self) -> bool:
        return self.state not in ("pending", "running")

    @property
    def key(self) -> str:
        return f"{self.agent}__{self.task}"

    @property
    def cached_pct(self) -> float | None:
        if not self.prompt_tokens:
            return None
        return 100.0 * self.cached_tokens / self.prompt_tokens


def read_cell(run_tag: str, agent: str, task: str) -> CellRecord:
    """Read one cell from disk.  Missing job dir -> ``pending``."""
    rec = CellRecord(agent=agent, task=task)
    job_dir = JOBS_DIR / f"{run_tag}__{agent}__{task}"
    if not job_dir.is_dir():
        return rec

    attempt = _trial_dir(job_dir, task)
    since = attribution_since(job_dir, task)
    rec.attribution_since = since

    if attempt is None:
        return rec

    rec.attempt_dir = str(attempt.relative_to(BENCH_DIR))
    result = _read_json(attempt / "result.json") or {}

    for phase in ("agent_setup", "agent_execution", "verifier"):
        span = result.get(phase)
        if isinstance(span, dict):
            start = _iso_epoch(span.get("started_at"))
            end = _iso_epoch(span.get("finished_at"))
            if start and end and end >= start:
                rec.phases[phase] = round(end - start, 1)
            if phase == "agent_setup" and start:
                rec.started_at = start
            if phase == "verifier" and end:
                rec.finished_at = end

    rec.started_at = rec.started_at or _iso_epoch(result.get("started_at"))
    rec.finished_at = rec.finished_at or _iso_epoch(result.get("finished_at"))
    if rec.started_at and rec.finished_at and rec.finished_at >= rec.started_at:
        rec.wall_secs = round(rec.finished_at - rec.started_at, 1)

    reward_path = attempt / "verifier" / "reward.txt"
    if reward_path.is_file():
        try:
            rec.reward = float(reward_path.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            rec.reward = None
    else:
        rewards = (result.get("verifier_result") or {}).get("rewards") or {}
        if "reward" in rewards:
            try:
                rec.reward = float(rewards["reward"])
            except (TypeError, ValueError):
                rec.reward = None

    ctrf = _read_json(attempt / "verifier" / "ctrf.json")
    if ctrf:
        summary = ((ctrf.get("results") or {}).get("summary")) or {}
        if isinstance(summary.get("passed"), int):
            rec.partial_passed = summary["passed"]
            rec.partial_total = summary.get("tests")
        # Keep per-test rows: this is the only source that says *which* tests
        # failed, and the whole point of showing partial credit.
        for row in ((ctrf.get("results") or {}).get("tests") or []):
            if not isinstance(row, dict):
                continue
            name = str(row.get("name") or "").strip()
            if not name:
                continue
            rec.tests.append(
                {
                    "name": name,
                    "status": str(row.get("status") or "other"),
                    "trace": str(row.get("trace") or "").strip()[:400],
                }
            )
    if rec.partial_passed is None and rec.reward is not None:
        # Binary reward with no CTRF report: every test passed or the single
        # reward is the whole story.
        rec.partial_passed, rec.partial_total = (1, 1) if rec.reward >= 1 else (0, 1)

    exc_info = result.get("exception_info")
    if isinstance(exc_info, dict):
        rec.exception = exc_info.get("exception_type") or exc_info.get("message")
    if not rec.exception:
        rec.exception = _exception_from_txt(job_dir)

    # Only trust a verdict that is actually terminal.
    if rec.reward is not None or rec.exception:
        rec.state = _classify(rec)
    elif rec.started_at:
        rec.state = "running"

    heartbeat = attempt / "agent"
    if heartbeat.is_dir():
        newest = max(
            (_mtime(p) for p in heartbeat.rglob("*") if p.is_file()), default=0.0
        )
        if newest:
            rec.heartbeat_age_secs = round(time.time() - newest, 1)
    return rec


def _classify(rec: CellRecord) -> str:
    exc = (rec.exception or "").lower()
    if exc:
        if any(marker in exc for marker in TIMEOUT_MARKERS):
            return "timeout"
        return "exception"
    if rec.reward is None:
        return "running"
    return "pass" if rec.reward >= 1 else "fail"


def _exception_from_txt(job_dir: Path) -> str | None:
    """Fallback: harbor drops a plain-text exception dump next to the trial."""
    hits = sorted(job_dir.glob("*/exception.txt"))
    hits += sorted(job_dir.glob("exception.txt"))
    for path in hits:
        try:
            lines = [
                ln.strip()
                for ln in path.read_text(encoding="utf-8", errors="replace").splitlines()
                if ln.strip()
            ]
        except OSError:
            continue
        for line in reversed(lines):
            if "Error" in line or "Exception" in line or "Timeout" in line:
                return line[:200]
    return None


# ---------------------------------------------------------------------------
# status.tsv (hint only)
# ---------------------------------------------------------------------------


def read_status_tsv(run_tag: str) -> list[dict[str, str]]:
    path = RUNS_DIR / run_tag / "status.tsv"
    if not path.is_file():
        return []
    rows: list[dict[str, str]] = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) != 6:
            continue
        agent, task, rc, reward, wall, status = parts
        rows.append(
            {
                "agent": agent,
                "task": task,
                "rc": rc,
                "reward": reward,
                "wall": wall,
                "status": status,
            }
        )
    return rows


def known_run_tags() -> list[str]:
    """Run tags we have artifacts for, newest first."""
    tags: list[tuple[float, str]] = []
    if RUNS_DIR.is_dir():
        for path in RUNS_DIR.iterdir():
            if path.is_dir():
                tags.append((_mtime(path), path.name))
    if JOBS_DIR.is_dir():
        for path in JOBS_DIR.iterdir():
            name = path.name
            if "__" in name:
                tag = name.split("__", 1)[0]
                if not any(t == tag for _m, t in tags):
                    tags.append((_mtime(path), tag))
    tags.sort(reverse=True)
    return [t for _m, t in tags]


def latest_run_tag() -> str | None:
    tags = known_run_tags()
    return tags[0] if tags else None


# ---------------------------------------------------------------------------
# proxy ledger
# ---------------------------------------------------------------------------


def read_events(path: Path | None = None) -> list[dict[str, Any]]:
    """Parse the proxy JSONL log, skipping torn lines."""
    target = path or EVENTS_PATH
    if not target.is_file():
        return []
    rows: list[dict[str, Any]] = []
    try:
        with target.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return rows


def attribute(rows: Iterable[dict[str, Any]], records: dict[str, CellRecord]) -> None:
    """Fold proxy rows into the matching cell records, in place.

    A row belongs to the newest cell whose attribution window it falls into;
    superseded attempts therefore stop contributing as soon as a newer attempt
    directory appears.
    """
    windows = [
        (rec.attribution_since, rec)
        for rec in records.values()
        if rec.attribution_since is not None
    ]
    windows.sort(key=lambda item: item[0])

    for row in rows:
        ts = row.get("ts")
        if not isinstance(ts, (int, float)):
            continue
        agent = row.get("agent")
        task = row.get("task")
        rec = records.get(f"{agent}__{task}")
        if rec is None or rec.attribution_since is None:
            continue
        if ts < rec.attribution_since:
            continue
        if row.get("method") == "GET":
            rec.probes += 1
            continue
        usage = row.get("usage") or {}
        rec.rounds += 1
        rec.prompt_tokens += int(usage.get("input") or 0)
        rec.cached_tokens += int(usage.get("cached") or 0)
        rec.output_tokens += int(usage.get("output") or 0)
        rec.reasoning_tokens += int(usage.get("reasoning") or 0)
        rec.tool_calls += int(row.get("tool_calls") or 0)
        peak = int(usage.get("input") or 0)
        rec.peak_ctx = max(rec.peak_ctx, peak)
        if row.get("proxy_error") or (row.get("status") or 0) >= 400:
            rec.errors += 1
        last = rec.last_request_at or 0.0
        rec.last_request_at = max(last, ts)


# ---------------------------------------------------------------------------
# aggregate payload
# ---------------------------------------------------------------------------


def build_payload(
    run_tag: str | None,
    agents: list[str],
    tasks: list[str],
    running_cells: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Everything the UI needs for one render, computed from disk."""
    running_cells = running_cells or {}
    tag = run_tag or latest_run_tag() or "run"

    records: dict[str, CellRecord] = {}
    for agent in agents:
        for task in tasks:
            records[f"{agent}__{task}"] = read_cell(tag, agent, task)

    # status.tsv is a hint: fill wall_secs for cells whose job dir is gone.
    for row in read_status_tsv(tag):
        rec = records.get(f"{row['agent']}__{row['task']}")
        if rec is None or rec.wall_secs is not None:
            continue
        try:
            rec.wall_secs = float(row["wall"])
        except (TypeError, ValueError):
            pass
        if rec.state == "pending" and row["status"] not in ("running",):
            note = row["status"]
            if note == "stalled":
                rec.state = "stalled"
            elif note == "skipped-lowdisk":
                rec.state = "pending"
            else:
                rec.state = "fail"
            rec.note = note

    attribute(read_events(), records)

    now = time.time()
    for key, info in running_cells.items():
        rec = records.get(key)
        if rec is None:
            continue
        rec.running = True
        rec.pid = info.get("pid")
        age = info.get("heartbeat_age_secs")
        rec.heartbeat_age_secs = age
        if rec.state in ("pending", "running"):
            rec.state = "running"

    cells = [records[k] for k in sorted(records)]
    counts: dict[str, int] = {}
    for rec in cells:
        counts[rec.state] = counts.get(rec.state, 0) + 1

    done = [c for c in cells if c.done]
    walls = [c.wall_secs for c in done if c.wall_secs]
    mean_wall = round(sum(walls) / len(walls), 1) if walls else None

    by_agent: list[dict[str, Any]] = []
    for agent in agents:
        subset = [c for c in cells if c.agent == agent]
        finished = [c for c in subset if c.done]
        by_agent.append(
            {
                "agent": agent,
                "cells": len(subset),
                "done": len(finished),
                "pass": sum(1 for c in subset if c.state == "pass"),
                "fail": sum(1 for c in subset if c.state == "fail"),
                "timeout": sum(1 for c in subset if c.state == "timeout"),
                "exception": sum(1 for c in subset if c.state == "exception"),
                "stalled": sum(1 for c in subset if c.state == "stalled"),
                "rounds": sum(c.rounds for c in subset),
                "prompt_tokens": sum(c.prompt_tokens for c in subset),
                "cached_tokens": sum(c.cached_tokens for c in subset),
                "output_tokens": sum(c.output_tokens for c in subset),
                "reasoning_tokens": sum(c.reasoning_tokens for c in subset),
                "tool_calls": sum(c.tool_calls for c in subset),
                "errors": sum(c.errors for c in subset),
                "partial_passed": sum(c.partial_passed or 0 for c in finished),
                "partial_total": sum(c.partial_total or 0 for c in finished),
                "mean_wall_secs": (
                    round(
                        sum(c.wall_secs for c in finished if c.wall_secs)
                        / max(1, len([c for c in finished if c.wall_secs])),
                        1,
                    )
                    if any(c.wall_secs for c in finished)
                    else None
                ),
            }
        )

    totals = {
        "rounds": sum(c.rounds for c in cells),
        "prompt_tokens": sum(c.prompt_tokens for c in cells),
        "cached_tokens": sum(c.cached_tokens for c in cells),
        "output_tokens": sum(c.output_tokens for c in cells),
        "reasoning_tokens": sum(c.reasoning_tokens for c in cells),
        "tool_calls": sum(c.tool_calls for c in cells),
        "errors": sum(c.errors for c in cells),
        "probes": sum(c.probes for c in cells),
    }

    def row(c: CellRecord) -> dict[str, Any]:
        return {
            "agent": c.agent,
            "task": c.task,
            "key": c.key,
            "state": c.state,
            "done": c.done,
            "reward": c.reward,
            "partial_passed": c.partial_passed,
            "partial_total": c.partial_total,
            "wall_secs": c.wall_secs,
            "phases": c.phases,
            "exception": c.exception,
            "note": c.note,
            "running": c.running,
            "pid": c.pid,
            "heartbeat_age_secs": c.heartbeat_age_secs,
            "rounds": c.rounds,
            "prompt_tokens": c.prompt_tokens,
            "cached_tokens": c.cached_tokens,
            "output_tokens": c.output_tokens,
            "reasoning_tokens": c.reasoning_tokens,
            "tool_calls": c.tool_calls,
            "peak_ctx": c.peak_ctx,
            "errors": c.errors,
            "probes": c.probes,
            "cached_pct": (
                round(100.0 * c.cached_tokens / c.prompt_tokens, 1)
                if c.prompt_tokens
                else None
            ),
            "last_request_at": c.last_request_at,
            "last_request_age_secs": (
                round(now - c.last_request_at, 1) if c.last_request_at else None
            ),
            "started_at": c.started_at,
            "finished_at": c.finished_at,
            "attempt_dir": c.attempt_dir,
            "tests": c.tests,
        }

    return {
        "tag": tag,
        "generated_at": now,
        "agents": agents,
        "tasks": tasks,
        "task_catalog": list_task_catalog(),
        "now": now,
        "matrix": [row(c) for c in cells],
        "by_agent": by_agent,
        "totals": totals,
        "progress": {
            "total": len(cells),
            "done": len(done),
            "running": counts.get("running", 0),
            "pending": counts.get("pending", 0),
            "stalled": counts.get("stalled", 0),
            "pass": counts.get("pass", 0),
            "fail": counts.get("fail", 0),
            "timeout": counts.get("timeout", 0),
            "exception": counts.get("exception", 0),
            "mean_wall_secs": mean_wall,
        },
    }
