# mica-bench dashboard

Read-only, zero-dependency web dashboard for observing a running benchmark
matrix (agents × tasks). One file: `dashboard.py` (Python 3 stdlib only — no
pip, no npm, no CDN; works fully offline).

## Run

```bash
python3 /Users/qironglin/mica-bench/dashboard/dashboard.py
# -> http://127.0.0.1:8790
```

Options:

| flag | default | meaning |
|---|---|---|
| `--bench-dir` | `~/mica-bench` (or `$MICA_BENCH_DIR`) | benchmark home |
| `--tag` | newest dir under `runs/` | run tag, e.g. `reg2` |
| `--tasks` | `tasks.txt` | comma-separated task names |
| `--agents` | `mica,codex,opencode,kimi-code` | comma-separated agents |
| `--concurrency` | `5` | scheduler parallelism, used for the ETA |
| `--host` / `--port` | `127.0.0.1` / `8790` | bind address |

Unknown tags/agents degrade to whatever exists on disk rather than erroring, so
it stays useful while a run is being renamed or restarted.

## HTTP surface

- `GET /` — the page (self-contained HTML + inline JS/CSS, polls every 5s).
- `GET /api/data` — the full JSON payload (see below).
- `GET /health` — `{"ok": true, "pid": ...}`.

The page's JS is embedded in `dashboard.py` inside `PAGE = r"""..."""`.
`render_check.js` extracts it from that same string (single source of truth, no
second copy of the markup) and executes it against a live payload using a
minimal DOM shim, so a rendering regression fails loudly instead of only
appearing in a browser:

```bash
python3 dashboard.py &      # must be serving on :8790
node render_check.js        # fetches /api/data and renders it
node render_check.js payload.json   # or render a saved payload
```

It asserts the rendered row counts per section and that the progress
invariant `done + running + pending + stalled == total` holds.

## Data sources (all read-only)

- `runs/<tag>/status.tsv` — per-cell line: `agent · task · rc · reward · wall · note`.
  Treated as a **hint, not the truth**: rows can go missing if a script was
  edited while running, so verdicts are backfilled from the job dirs.
- `events.jsonl` — the LLM request log (authoritative for rounds/tokens).
- `harbor-jobs/<tag>__<agent>__<task>/<task>__<hash>/` — per-attempt dir:
  `verifier/reward.txt` (0/1), `verifier/ctrf.json` (partial credit),
  `result.json` (phase timings, exception type), `agent/*.txt` (heartbeat).
- running cells — from `ps -eo command` matching `cell*.sh <tag> <agent> <task>`.
- `runs/<tag>/REPORT.md` is **not** read; the dashboard computes from raw data
  and is therefore fresher than the report snapshot.

### Attribution rule (important)

Rounds/tokens per cell are windowed by **the attempt directory's birthtime**
(host clock), clamped to now; the newest attempt dir wins when a cell was
re-run. Requests outside every window belong to superseded attempts and are
**excluded** (reported under `sources.excluded_*`) — otherwise a re-run would be
summed onto the previous attempt's totals.

Never derive the window from `min(mtime)` of files inside the attempt dir:
artifacts collected out of containers keep the image-build mtime, which can be
weeks old, silently merging all attempts together and inflating rounds/tokens.

### Errors vs probes

A request is counted as an error only if it belongs to a live attempt window and
returns HTTP ≥400. Harmless capability probes (e.g. codex's bare
`GET /responses` → 405) are counted separately as `probes` per cell, because
lumping them in makes it look like half of an agent's requests are failing.

## `/api/data` payload

`generated_at`, `tag`, `agents`, `tasks`, `progress`, `matrix`, `live`,
`by_agent`, `errors`, `timeline`, `sources`.

- `progress` — `total/done/running/pending/stalled`, `state_counts`,
  `done_pct`, `elapsed_secs`, `mean_cell_wall_secs`, `concurrency`, `eta_secs`,
  `eta_at`.
- `matrix` — flat list of all `agents × tasks` cells: `state`
  (`pass|fail|timeout|exception|stalled|running|pending`), `done`, `reward`,
  `partial` / `partial_passed` / `partial_total`, `wall_secs` + `wall_source`,
  `note`, `exception`, `caveat`, `phases{setup,exec,verify}`, `started_at`,
  `finished_at`, `rounds`, `probes`, `errors`, `prompt_tokens`, `cached_tokens`,
  `output_tokens`, `reasoning_tokens`, `tools`, `peak_ctx`, `latest_seq`,
  `last_request_at`, `last_request_age_secs`, `attribution_since`,
  `heartbeat_age_secs`, `process_age_secs`, `pid`.
- `state_counts` note: a finished cell carrying a `stalled` note is counted as
  `stalled` but is part of `done` — the invariant is
  `done + running + pending + stalled_live == total`.
- `sources` — where each number came from, plus `excluded_rows` /
  `excluded_errors` / `excluded_probes` so excluded data is never silent.

## Guarantees

Writes nothing outside this directory: no file writes, no `docker`, no process
signals. Safe to run against a live matrix.
