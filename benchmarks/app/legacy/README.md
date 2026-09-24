# legacy

Superseded by `benchmarks/app/console`. Kept because the notes in the runbook still
refer to them, and because they document the pitfalls the console's engine had to
re-implement.

> **These scripts are not runnable as-is.** They hardcode the pre-reorg layout
> (`~/mica-bench/`, with `runs/`, `harbor-jobs/`, `env.sh`, `proxy.py` all
> flat at the root). The tree was later split into
> `benchmarks/{app,persistence,terminal-bench}`; the paths inside these files
> were deliberately left untouched so they stay a faithful record of how the
> runs they document were actually executed. Use the console or
> `benchmarks/app/runner/run-agent.sh` instead.

| file | replaced by |
|---|---|
| `cell.sh`, `cell2.sh` | `console/server/engine.py` (`_spawn` / `_supervise` / `_collect`) |
| `bench-run.sh` … `bench-run5.sh` | `console/server/engine.py` (`_scheduler_loop`) |
| `watchdog.sh`, `watchdog2.sh` | `console/server/engine.py` (`reclaim_async`) |
| `report.py`, `collect.py`, `summarize.py`, `final_summary.py` | `console/server/results.py` |
| `dashboard/` | `console/web` |

Why they were replaced: the scheduler inferred liveness from
`pgrep -f 'cell[0-9]*\.sh'` rather than owning child handles, so nothing could be
stopped reliably; and "is this cell done / what did it score / which proxy rows
are its" had three separate implementations that disagreed with each other.

Two pieces of hard-won knowledge moved rather than disappeared:

* `cell2.sh`'s stall policy — silence during the agent phase means dead, but the
  image build and the verifier may be quiet far longer, and a stall *after* the
  agent phase is never retried. Now in `engine.py` with the same constants.
* `report.py`'s attribution rule — a cell's proxy window starts at the
  **birthtime of its attempt directory**, never `min(mtime)` over collected
  artifacts. Now in `results.py`, with the reason written down.
