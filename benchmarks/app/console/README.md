# mica-bench console

Agent harness comparison harness: a control plane plus a web console for running
Terminal-Bench tasks against several coding agents at a **fixed model**, and for
reading back the token/round cost of each one.

It replaces the original shell scaffold (`cell.sh`, `bench-run*.sh`, `report.py`,
`dashboard.py`). Those scripts drifted into three separate implementations of the
same facts — "is this cell done", "what did it score", "which proxy rows belong
to it" — and none of them could be *stopped* from a UI, because liveness was
inferred from `pgrep -f 'cell[0-9]*\.sh'` rather than owned process handles.

## Layout

```
console/
├── server/            python control plane (stdlib only)
│   ├── main.py        HTTP server + routes + static hosting
│   ├── engine.py      proxy supervisor, scheduler, per-cell supervision
│   ├── results.py     read side: the single source of truth
│   ├── harbor.py      builds the `harbor run` invocation for one cell
│   ├── catalog.py     agent + task catalogue
│   └── settings.py    settings.json, routes.json, generated env.sh
├── web/               Vite + React 19 + TS + Tailwind + shadcn (see below)
│   └── dist/          built UI, served by server/main.py
├── settings.json      live configuration (chmod 600, holds the API key)
└── routes.json        agent -> upstream routing, hot-reloaded by proxy.py
```

## Running it

```bash
# 1. backend (also serves the built UI)
cd benchmarks/app/console
python3 -m server.main            # http://127.0.0.1:8790

# 2. UI, one of
cd benchmarks/app/console/web && npm run build   # build once, backend serves it
cd benchmarks/app/console/web && npm run dev     # or live-reload on :5310
```

Everything is driven from the page: start/stop a run, start/stop the recording
proxy, and edit the API key / base URLs / model.

## The one rule that matters

**Token and round counts come from the recording proxy, never from the agent.**

Every agent is pointed at `http://host.docker.internal:<port>/agent_bench/<agent>/task=<task>`
and the proxy appends one JSON line per upstream request to `events.jsonl`. Agents
disagree about what to report (or report nothing at all), so the proxy is the
only comparable source.

Two consequences worth knowing:

* **Routing is per agent, not per process.** DeepSeek speaks the Anthropic wire
  format under `/anthropic` and the OpenAI one under `/v1`, so `routes.json` maps
  `claude-code -> {base: https://api.deepseek.com, path_prefix: /anthropic}`.
  The proxy re-reads that file when its mtime changes, so repointing an agent
  does not require a restart (and does not drop in-flight requests).
* **Usage is normalised to one shape.** OpenAI reports `prompt_tokens` *including*
  the cached part; Anthropic's `input_tokens` *excludes* `cache_read_input_tokens`
  and `cache_creation_input_tokens`. The proxy emits OpenAI-style semantics for
  both, otherwise one agent looks an order of magnitude cheaper than it is.

## Agents

| id | harbor agent | wire format | notes |
|---|---|---|---|
| `mica` | `benchmarks.app.agents.mica_code:MicaCode` | OpenAI | injected as a tarball |
| `codex` | `codex` | OpenAI (Responses) | |
| `claude-code` | `claude-code` | Anthropic | needs `HARBOR_ALLOW_INSECURE_MODEL_BASE_URL=true` because the proxy is plain http |

`opencode` and `kimi-code` were dropped from the matrix.

## Supervision policy (carried over from `cell2.sh`)

Silence means different things in different phases:

| phase | silence budget | retried on stall |
|---|---|---|
| image build / agent install | `setup_secs` (30 min) | yes |
| agent execution | `stall_secs` (10 min) | yes |
| verifier | `stall_secs × verify_grace` (30 min) | **no** |

A stall is only declared after also checking container CPU: ≥ 1% means it is
compiling, not wedged. A stall *after* the agent phase is never retried — the
agent budget is already spent, so a retry burns another ~1.7 h to land in the
same place.

Before each cell the engine refuses to start if free disk is under
`min_free_mb`. Reclaiming containers, **networks**, `*__env-main` images (tagged,
so `image prune` never touches them) and `fstrim` happens **once, after the last
cell of the run**, not after every cell.

That timing is load-bearing. The prune deletes containerd content, and a task
image being pulled by another cell at that moment dies with `commit failed:
rename /var/lib/containerd/…/ingest/<id>/data …/blobs/sha256/<digest>: no such
file or directory`. Reclaim used to fire per cell finish, and in `run-0924-1408`
that killed all three `vf2-speedup-networkx` cells the instant mica's first cell
completed. A single `_RECLAIM_LOCK` additionally keeps a pull from overlapping a
reclaim left over from the previous run; the scheduler waits it out before
dispatching.

Each task's pinned images come from its own `task.toml`
(`catalog.task_image_refs`), and the scheduler pulls them one at a time before
that task's first cell starts. Harbor pulls rather than builds whenever
`docker_image` is set, so without this every agent of a task pulled the same
image independently — three downloads and three chances to collide.

The network prune is not optional: every trial creates its own bridge, and once
colima exhausts its subnettable address space the next cell dies at setup with
`all predefined address pools have been fully subnetted`, which looks exactly
like an agent failure and is not one.

## Reading the results

`server/results.py` is the only place that answers "what happened". It takes
`harbor-jobs/<tag>__<agent>__<task>/<task>__<hash>/` as authoritative and treats
`runs/<tag>/status.tsv` as a hint that gets backfilled.

* **Completion** — a verdict exists only when the trial produced
  `verifier/reward.txt` or the job recorded an exception. A `reward.txt` written
  mid-verification is not a verdict, which is why `result.json` is consulted too.
* **Attribution window** — a cell's proxy rows start at the *birthtime* of its
  newest attempt directory, clamped to now. Never `min(mtime)`: artifacts
  collected out of the container keep the image-build mtime, so `min` drags in
  every previous attempt (it once inflated one cell from 30 rounds to 76).
* **Partial credit** — `verifier/ctrf.json` gives passed/total tests. Binary
  reward alone is noisy here: the same agent+task flipped between pass and fail
  across runs, so both numbers are shown.
* **Per-test detail** — the same `ctrf.json` carries a `tests[]` array, which is
  the only source that says *which* cases failed. It is surfaced in the cell
  dialog (failing tests first, with the failure trace) and matters because
  "3/7" alone cannot tell you whether the agent missed one edge case or four.
  Only pytest-based verifiers emit it; shell-reward tasks fall back to the
  single binary verdict and the section is simply absent.
* **Task categories** — parsed from each task's `[metadata] category` in
  `task.toml` (7 buckets over 66 tasks). Grouping the picker by category is what
  makes selection tractable; the flat chip cloud was unreadable. `catalog.py`
  owns the parse and `CATEGORY_ORDER` owns the display order.

## The UI

Stack and conventions mirror `qirong-application`: Vite 8 · React 19 · TS 7 ·
Tailwind 3.4 · shadcn-style components, theme tokens in `src/index.css` as the
single source of colour, `cn()` in `src/lib/utils.ts`, components under
`src/components/ui/`. `tailwind.config.js` is the reference repo's preset with
the same token→utility mapping.

Three deliberate additions to the token set, all needed to signal pass / fail /
running at a glance and to lift cards off the page:

| token | role |
|---|---|
| `--canvas` | page background; `--background` stays the card/surface white |
| `--success` | pass / running |
| `--warning` | degraded (low disk, non-fatal) |

**Light only.** The dark palette is deliberately not carried over from the
reference repo, `main.tsx` does not add a `.dark` class, and `darkMode` is unset
in `tailwind.config.js` — so no `dark:` variants should be introduced. One theme
means one thing to keep in sync. `Badge` has a `size` prop for this reason:
`md` (h-8) lets a badge sit in a row of buttons/selects without shifting the
baseline, which is what makes the header row line up.

`DialogContent` pins its column to `grid-cols-[minmax(0,1fr)]`. That is load
bearing: with a bare `grid` the column takes the widest child's min-content, so
the log `<pre>` in `CellDrawer` (one very long command line) stretched the dialog
to thousands of pixels and pushed every metric out of view.

Two more `CellDrawer` constraints worth keeping:

* The raw harbor log is collapsed by default and rendered with
  `whitespace-pre-wrap break-all` (not `pre` with horizontal scroll). It is long,
  rarely the answer, and its first line is a multi-hundred-character env dump.
* The test list pages at `TEST_PAGE` rows — `wal-recovery-ordering` has 97
  cases, and painting them all on open makes the dialog visibly janky.

## Credential handling

The engine passes the API key twice: in the child env, and as an
`--agent-env OPENAI_API_KEY=<key>` argument. The argument form used to land
verbatim in every `runs/<tag>/<key>.log`, so the key was readable from the UI
and by anything that could read `runs/`. `settings.redact()` now masks it both
when the log line is written and when `/api/log` serves it (defence in depth for
logs written before the fix). Do not add a new log-writing path that bypasses
it.

## API

| method | path | purpose |
|---|---|---|
| GET | `/api/state` | settings, proxy status, run state, catalogue, free disk |
| GET | `/api/results?tag=&agents=&tasks=` | matrix, per-agent totals, token ledger |
| POST | `/api/settings` | patch settings (rewrites `routes.json` + `env.sh`) |
| POST | `/api/proxy/start` \| `/api/proxy/stop` | recording proxy |
| POST | `/api/run/start` | `{tag, parallelism, agents[], tasks[]}` |
| POST | `/api/run/stop` | stop every cell (and optionally the proxy) |
| POST | `/api/cell/start` \| `/api/cell/stop` | one cell |
| GET | `/api/log?key=<agent>__<task>` | cell log tail |
| GET | `/api/events?limit=` | recent proxy rows |

## Security

The server has **no authentication** — anything that can reach the port can
start processes and read the API key. It binds `127.0.0.1` only; do not expose it
on a LAN interface.

`settings.json` and the generated `env.sh` are chmod 600.
