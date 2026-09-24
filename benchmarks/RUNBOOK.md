# Benchmark runbook — comparing coding-agent harnesses at a fixed model

This document records **how** the agent comparison is run, so any cell can be
reproduced or re-run independently. It is updated as the harness changes.

Scope: compare *agent harnesses* (**mica-code vs codex vs claude-code**) on
identical tasks with an identical model. Model quality is held constant on
purpose — the variable under test is the agent. `opencode` and `kimi-code` were
dropped from the matrix (see §7); their historical rows are kept below and are
labelled as such.

---

## 1. What is being measured

| Metric | Source | Why this source |
|---|---|---|
| Task success | `reward.txt` from the task verifier (binary) | Ground truth, written by the task author |
| Partial credit | CTRF report from the verifier, when present | Binary reward hides near-misses |
| Prompt tokens (incl. cache) | **local proxy** | Provider-canonical; an agent's self-reported usage is optional and sometimes absent entirely |
| Cached tokens / cache hit rate | **local proxy** | Prefix-cache efficiency is a first-class agent property |
| Output tokens | **local proxy** | |
| LLM rounds (= requests) | **local proxy** | "How many iterations did the agent need" |
| Tool calls issued | **local proxy** (parsed from responses) | How much tool use the loop produced |
| Wall clock | harbor job timestamps | |

**The proxy is the source of truth for usage.** Agents report usage in
inconsistent shapes, and at least one agent reports none at all. The proxy
observes the exact HTTP traffic, so every number is directly comparable.

---

## 2. File layout

```
benchmarks/
  README.md                      overview of the three areas below
  RUNBOOK.md                     this file

  app/                           the code that runs benchmarks
    console/                     web control plane (server/ + web/ + tools/)
      server/*.py                zero-dep HTTP backend; settings.py owns the layout
      settings.json              run config + API key (chmod 600, gitignored)
      routes.json                per-agent upstream routing, hot-reloaded by proxy
    proxy.py                     per-agent, per-task LLM proxy + JSONL log
    runner/run-agent.sh          one (agent, task) trial via harbor
    agents/mica_code.py          harbor adapter: MicaCode(BaseInstalledAgent)
    agents/test_mica_code.py     pytest for the adapter
    agents/smoke-task/ quick-task/   tiny tasks for plumbing checks
    env.sh                       credentials + model + task dir (chmod 600)
    artifacts/mica-agent.tar.gz  packaged mica runtime shipped into containers
    artifacts/verify/            cross-arch mica binaries for manual checks
    legacy/                      superseded shell/python runners, kept for reference
                                 (cell*.sh, bench-run*.sh, report/collect/summarize.py)

  persistence/                   run records (all gitignored, except its README)
    runs/<tag>/status.tsv                agent/task/rc/reward/wall row per cell
    runs/<tag>/<agent>__<task>.log       raw log per cell
    runs/<tag>/REPORT.md                 machine-generated summary
    results-*.txt                        published comparison tables
    events.jsonl                         append-only request log (the dataset)
    harbor-jobs/<tag>__<agent>__<task>/  harbor output per cell
    experiments/                         early ablation records + mica HOME snapshots

  terminal-bench/                one benchmark: its task package
    tasks/                       66 downloaded tasks
    tasks.txt                    default task subset for manual runs
```

git tracks code and docs only: the whole of `persistence/` (run records —
verdicts, result tables, Harbor artifacts, proxy traffic) and the downloaded
`tasks/` are gitignored so the repo stays cloneable. `benchmarks/.gitignore`
is the single place that decides this; conclusions worth keeping belong in
this RUNBOOK.

---

## 3. Setup from scratch

```bash
# 1. docker: colima with VZ + Rosetta (see §9 for why not qemu)
colima start --vz-rosetta --cpu 6 --memory 12 --disk 60

# 2. harbor
python3.12 -m venv /tmp/harbor-env
/tmp/harbor-env/bin/pip install harbor          # 0.23.0 at time of writing

# 3. dataset
/tmp/harbor-env/bin/harbor download terminal-bench -o /tmp/tbds
cp -R /tmp/tbds/terminal-bench/. benchmarks/terminal-bench/tasks/

# 4. credentials (never committed)
cat > benchmarks/app/env.sh <<'EOF'
export MICA_BENCH_API_KEY="..."
export MICA_BENCH_MODEL="deepseek-flash"
export MICA_BENCH_MODEL_QUALIFIED="openai/deepseek-flash"
export MICA_BENCH_API_BASE="https://api.deepseek.com"
export MICA_BENCH_TASKS="benchmarks/terminal-bench/tasks"
export MICA_BENCH_JOBS_DIR="benchmarks/persistence/harbor-jobs"
export MICA_BENCH_TARBALL="benchmarks/app/artifacts/mica-agent.tar.gz"
EOF
chmod 600 benchmarks/app/env.sh

# 5. mica runtime tarball (rebuild after any mica source change)
cd <repo> && bun run build
tar -czf benchmarks/app/artifacts/mica-agent.tar.gz -C <dist dir> ...

# 6. proxy
python3 benchmarks/app/proxy.py &
```

---

## 4. The proxy

`proxy.py` is a logging reverse proxy in front of the model API. Every agent is
pointed at **its own URL prefix**, so attribution never depends on parsing
prompts:

```
/agent_bench/<agent>/task=<task-id>/<upstream-path>
        │            │            └── forwarded verbatim, e.g. /responses
        │            └── the benchmark task id (matrix cell)
        └── the harness under test
```

Example: mica working on `html-js-filter` sends its base URL as

```
http://host.docker.internal:8899/agent_bench/mica/task=html-js-filter
```

so a request the client would normally send to `/responses` arrives as
`/agent_bench/mica/task=html-js-filter/responses`, is logged, and is forwarded
to `https://api.deepseek.com/responses`.

### What each log line records

| Field | Meaning |
|---|---|
| `agent`, `task`, `seq` | cell identity + request ordinal within the cell |
| `mode` | `responses` or `chat_completions` (which protocol the agent speaks) |
| `input_count`, `kinds` | message/item counts by role/type |
| `history_tool_calls`, `history_tool_outputs` | tool history the agent re-sends |
| `image_refs` | media blocks on the wire |
| `req_bytes` | request payload size |
| `status`, `duration_ms`, `ttfb_ms` | provider status + latency, first-byte latency |
| `tool_calls` | tool calls the model *issued* in this response |
| `finish`, `upstream_error` | stop reason, or the provider error text |
| `usage.input / cached / output / reasoning` | normalized usage |
| `error_body` | first 600 bytes of any >=400 response |

`PROXY_SAVE_BODIES=1` additionally dumps raw request bodies per agent for
deep-dives.

### Errors vs probes

`err` in the reports counts only **failed model requests** (`POST` with status
>=400). Codex additionally issues a handful of `GET /responses` calls that the
provider answers with 405; those are harness capability probes, counted in a
separate `probe` column. Conflating the two made codex look like it was failing
7 of 14 requests when in fact every completion succeeded.

The one genuine recurring error is opencode's: it fires an internal
small-model request (`gpt-5.4-nano`) that any single-model endpoint must
reject with 400. That is opencode's design, not a wiring bug.

### Why HTTP and not HTTPS

Terminating TLS would require shipping a CA into four different agent
containers, each with its own trust-store quirks; the benefit is zero for
token/latency accounting. Plain HTTP is deliberate.

---

## 5. Cell identity and re-runnability

A **cell** is one `(agent, task)` pair. Its identity is the pair itself:

- proxy route: `/agent_bench/<agent>/task=<task>`
- job directory: `harbor-jobs/<tag>__<agent>__<task>`
- log: `runs/<tag>/<agent>__<task>.log`

`run-agent.sh` wipes the job directory before starting, so re-running a cell by
id is always safe and never mixes runs. The `<tag>` names a whole matrix
invocation (`check1`, `reg1`, …) so several matrices can coexist.

---

## 6. Running

The matrix is driven by the **console** (`benchmarks/app/console`), a control plane
plus web UI that replaced `bench-run*.sh`, `cell2.sh`, `report.py` and
`dashboard.py`. Start it with `cd benchmarks/app/console && python3 -m server.main`
and open <http://127.0.0.1:8790>; run/stop, the recording proxy and all
credentials are operated from the page. See `console/README.md`.

The reason for the rewrite is process ownership: stopping a run needs real child
handles, and the old scaffold inferred liveness from
`pgrep -f 'cell[0-9]*\.sh'`, which also meant editing a script under a running
instance corrupted it (bash reads its script lazily by byte offset).

```bash
# one cell, by hand (still supported; env.sh is generated from console settings)
source benchmarks/app/env.sh
benchmarks/app/runner/run-agent.sh mica html-js-filter
```

Everything the console shows is recomputed from disk, so results survive a
console restart: `harbor-jobs/<tag>__<agent>__<task>/` is authoritative and
`runs/<tag>/status.tsv` is only a hint.

Reading a cell in the UI:

* Click any matrix cell. The dialog lists **which tests failed** (from
  `verifier/ctrf.json`, failing first, with the failure trace) — the partial
  score alone cannot distinguish "missed one edge case" from "missed four".
  Only pytest verifiers emit CTRF; shell-reward tasks show the binary verdict.
* The task picker groups the 66 tasks by their `task.toml` category (7 buckets)
  with per-group selected/total counts, so a selection is reviewable at a glance.

```bash
# results without the UI
cd benchmarks/app && python3 -c "
import sys; sys.path.insert(0,'console')
from server import results
p = results.build_payload('reg2', ['mica','codex'], ['session-window-debug'])
for r in p['matrix']: print(r['agent'], r['state'], r['rounds'], r['prompt_tokens'])
"
```

Validate a task before spending four agent runs on it:

```bash
benchmarks/app/runner/run-agent.sh oracle <task-id>
```

The `oracle` agent runs the task's reference solution. `reward=1` proves the
task and its verifier work on this platform, so a later failure is
attributable to the agent rather than the harness.

---

## 7. Per-agent wiring notes

These were all discovered empirically and are load-bearing.

The matrix is **mica / codex / claude-code**. `opencode` and `kimi-code` were
dropped: opencode needed two config overrides to avoid burning requests on a
small model our endpoint rejects, and kimi-code exposes no token usage of its
own. Their notes are kept below because the failure modes generalise.

### Two wire formats, one normalised ledger

| Agent | Model argument | Wire format | Base-URL env |
|---|---|---|---|
| mica, codex | `deepseek-flash` | OpenAI (`/v1`) | `OPENAI_BASE_URL` (+ `OPENAI_API_BASE`, `DEEPSEEK_BASE_URL`) |
| claude-code | `deepseek-flash` | Anthropic (`/anthropic`) | `ANTHROPIC_BASE_URL` (+ `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`) |

DeepSeek serves both formats: OpenAI-compatible under `/v1`, Anthropic-compatible
under `/anthropic` (<https://api-docs.deepseek.com/guides/anthropic_api/>). So the
proxy routes **per agent** — `routes.json` maps
`claude-code -> {base: https://api.deepseek.com, path_prefix: /anthropic}` while
everything else uses `path_prefix: ""`. claude-code appends its own
`/v1/messages`, which is why the prefix is `/anthropic` and not
`/anthropic/v1/messages`.

`deepseek-flash` works verbatim on both endpoints (verified by direct `curl`).
DeepSeek also maps Claude tier names server-side — `claude-sonnet*`/`claude-haiku*`
→ `deepseek-flash`, and `claude-opus*` → `deepseek-v4-pro`, which bills higher and
is therefore avoided on purpose.

claude-code needs `HARBOR_ALLOW_INSECURE_MODEL_BASE_URL=true`: harbor validates
`ANTHROPIC_BASE_URL` and refuses plain http (our proxy is reached over
`http://host.docker.internal`).

**Usage accounting must be normalised or the comparison is meaningless.** The two
formats disagree about whether the cache sits inside the input count:

- OpenAI: `prompt_tokens` *includes* the cached part, reported separately as
  `prompt_cache_hit_tokens`.
- Anthropic: `input_tokens` *excludes* the cache; the cached part is
  `cache_read_input_tokens` (reused) plus `cache_creation_input_tokens` (written).

The proxy emits OpenAI-style semantics for both (`input` = true total, `cached` =
subset), so claude-code does not appear an order of magnitude cheaper than it is.
Anthropic also splits usage across events — input tokens arrive in
`message_start`, output in `message_delta` — so the two halves are merged rather
than replaced.

### Silent bypass is the failure mode to watch for

When opencode was first configured with a `deepseek` provider it still *passed
the task*; the only symptom was an empty proxy log. Its base URL is only
injected for providers in `{openai, anthropic, google}`, so any other provider
name bypasses the proxy entirely. The lesson generalises to every agent: **a
cell with zero proxy requests is suspect**, which is why the console surfaces
the live request feed next to the matrix.

### mica adapter

`mica_code.py` (`MicaCode(BaseInstalledAgent)`) ships a prebuilt mica tarball
into the container, selects `mica-linux-arm64` / `-x64` by `uname -m`, and
needs no `config.json` (credentials arrive via `--agent-env`). It captures
stdout in-process rather than relying on a `tee` + `/logs` mount.

---

## 8. Environment notes

- **Host**: 8 cores / 16 GB, macOS arm64.
- **VM**: colima, 6 CPU / 12 GB / 60 GB disk. Docker data lives on
  `/mnt/lima-colima` (separate from the 19 GB VM root); watch
  `docker system df` and `docker builder prune -f` between matrices.
- **Rosetta, not qemu**: `mica` is a `bun build --compile` x64/arm64 binary.
  Under qemu the x64 build SIGILLs (`Illegal instruction`, exit 132). The VM
  runs with `--vz-rosetta`, so amd64 task images execute under Rosetta and the
  arm64 binary is used natively when the image is arm64.
- **Terminal-Bench task images are amd64-only.** `--force-build` does not help:
  TB task packages ship no task-level `environment/` Dockerfile, only
  `tests/Dockerfile`.
- **Container network**: task containers reach the host proxy at
  `host.docker.internal` (192.168.5.2 under this colima setup).
- **Timeouts**: codex and claude-code install Node (and then themselves) inside
  the task container, which blows past harbor's 360 s agent-setup default, so all
  runs pass `--agent-setup-timeout-multiplier 6`. Only the multiplier form exists
  on `harbor run`. The multiplier is a band-aid — see "Setup cost" below, and
  drop it back to 1–2 once the install is out of the run path so a genuinely
  wedged install fails fast instead of burning 36 minutes.

### Setup cost: why codex / claude-code take so long, and what to do

**The asymmetry is structural.** `mica` ships a prebuilt binary
(`--agent-kwarg tarball=...`), so its setup is ~0. `codex` and `claude-code` are
installed **inside every container, at run time**, from harbor's
`BaseInstalledAgent.install()`.

Measured on one host with three agents launched simultaneously on the same task
(`session-window-debug`, same model), timestamps taken from the attempt
directory:

| agent | cell wall | setup | install share |
|---|---|---|---|
| mica | 5m33s | ~0 (tarball) | 0% |
| claude-code | 14m49s | **~9m53s** | 67% |
| codex | 15m47s | ~4m20s (measured below) | 27% |

`codex`'s install step by step, same prebuilt amd64 image, inside the colima VM:

| step | time |
|---|---|
| `apt-get update` | 9s |
| `apt-get install nodejs npm` | **135s** |
| nvm installer | 6s |
| `nvm install 22` (node tarball) | 38s |
| `npm i -g @openai/codex` | 72s |
| **total** | **260s** |

Two things to note:

1. **Emulation is not the story.** A pure-CPU loop is only ~1.5× slower under
   amd64 emulation (0.31 s vs 0.20 s). The cost is the *volume* of serial
   network + small-file work — a Debian dependency tree, a Node tarball
   extraction, and an npm package tree — every time.
2. **The single biggest line item is also pure waste.** `install()` calls
   `ensure_system_dependencies(("curl","bash","nodejs","npm","ripgrep"))`, which
   **skips entirely when all those commands already exist**. A task image that
   already has node+npm would drop `apt-get update` + `apt-get install nodejs
   npm` — 144 s of the 260 s — for free. And on a musl image codex takes its
   `apk` branch (plain `npm i -g`), skipping nvm as well: ~72 s total.

Fixes, cheapest first:

| # | fix | effect | cost |
|---|---|---|---|
| 1 | Raise `--n-concurrent`: the install is per-cell and serial, so N concurrent cells amortize it N ways | ÷ N | none, already available |
| 2 | Base the task image on something with node+npm already present | codex install 260s → ~72s (−72%) | changes the task environment; TB tasks need Debian+python, so usually needs a derived image |
| 3 | **Bake the agent into a derived image** (`FROM <task-image>` + the install layer) | setup → ~0 for every later cell | build once per (task, agent); images are content-hash tagged and cached |
| 4 | Share an npm/nvm cache volume across cells | skips the download only | extraction still runs, so a small win |

**(3) works with no harbor changes** because both agents short-circuit on an
already-installed CLI — `_installed_codex_satisfies_version` /
`_installed_claude_satisfies_version` return early and `install()` becomes a
no-op. For a full 66-task × 2-agent sweep at ~4–10 min of install per cell, that
is ~15–25 h of pure install removed.

---

## 9. Pitfalls already paid for

- `--agent-import-path` is deprecated → use `--agent benchmarks.app.agents.mica_code:MicaCode`
  with `PYTHONPATH` pointing at the repo root.
- Local datasets via `-p` must **not** carry the `terminal-bench/` name prefix.
- A **verifier must write `/logs/verifier/reward.txt`**; the exit code is not
  consulted (TB verifiers exit 0 even on failure). A task whose `test.sh` only
  returns an exit status fails with `RewardFileNotFoundError`.
- `~` is not expanded inside double quotes; use `$HOME` in scripts.
- macOS ships bash 3.2 — no `export -f`, no `wait -n`, **no `declare -A`**.
  The associative-array one fails *silently against you*: `declare -A LOAD=()`
  errors, every `${LOAD[$agent]}` then reads the same indexed slot, so a
  load-balancing dispatcher computes identical loads for all agents and keeps
  re-picking the same cell — it launched one cell **three times**, and the three
  copies fought over the same job directory. The scheduler must stay
  arrays-and-loops only, and a `DRYRUN=1` mode that simulates load from a
  counter file is how the dispatch policy gets verified without touching the VM.
- `xargs -P` also wedged: it held 3 child slots and stopped starting the
  remaining 27 cells. The replacement dispatcher is idempotent, counts live
  processes for its global limit, and caps each agent at `ceil(PAR/agents)`
  slots so no single agent can be starved of CPU (which would inflate that
  agent's timeouts — a scoring bias rather than a measurement).
- Background jobs started with `&` die with their shell; long runs must be
  launched as real background tasks.
- **`nohup` alone is not enough either.** A scheduler launched as
  `nohup ./bench-run.sh ... &` from a tool-invoked shell was killed together
  with its process group, leaving orphaned containers behind and no
  dispatcher. Matrices must be started through the tool's own background-task
  mechanism; orphaned containers are identified by the `env-main-1` suffix and
  removed by hand.
- **Harbor's per-task agent budget is 8 h** (`[agent] timeout_sec = 28800` in
  every Terminal-Bench task). Left at the default, a single non-converging
  agent occupies a parallelism slot all night, so every run scales it to a
  bounded hour with `--agent-timeout-multiplier 0.125`.
- **Terminal-Bench tasks are much harder than their instruction length
  suggests.** `html-js-filter` has a ~900-byte instruction and sent every agent
  past 50 LLM rounds; codex and opencode were still iterating at 34 minutes
  with ~190 K-token contexts.
- Stale Docker CLI plugin symlinks (pointing at a deleted Docker.app) break
  harbor with `unknown flag: --project-name`; a stale `credsStore` in
  `~/.docker/config.json` also breaks it.
- **Never edit `cell.sh` / `bench-run*.sh` while cells are running.** bash reads
  a script lazily, by byte offset, so overwriting it rewrites the text a live
  instance is about to read next. Two cells died this way (they finished their
  trial but never reached the line that appends their `status.tsv` row). Either
  wait for the matrix to drain, or add a new sibling script under a new name.
- **Artifact files keep their image build mtimes.** Files collected back from
  the container are not stamped with the run's time: data-anonymization's
  `policy.yaml` arrives with the date it was baked into the task image (a month
  before the run). So an attempt window computed as "oldest file in the trial
  dir" jumps a month into the past and silently merges every earlier attempt of
  that cell into the current one. The window must come from the trial
  directory's **birth time** (host-side). Symptom that exposed it: a cell that
  had just re-run cleanly reported `err=3` and double the rounds it actually
  used.
- **A long-lived helper that pattern-matches script names goes stale silently.**
  The report waiter decided whether the matrix was still running via
  `pgrep -f 'cell\.sh <tag>'`; after the dispatcher was renamed to `cell2.sh` it
  matched nothing, concluded the matrix was finished, and exited without ever
  rendering the final report. Match on a tolerant pattern
  (`cell[0-9]*\.sh`) and keep one instance alive.
- **An agent can deadlock and burn a whole slot.** opencode was caught parked in
  `futex_wait_queue` at 0 % CPU with no child process, indefinitely, having
  already received all of its model responses normally. The likely trigger is
  Rosetta: TB images are amd64-only and Rosetta is x86_64-only translation (the
  VM kernel is aarch64, but an amd64 userland has no `ld-linux-aarch64.so.1`, so
  arm64 binaries cannot be substituted) — and futex emulation is a known weak
  spot. `cell.sh` therefore polls each attempt: silence in the job dir for
  `STALL_SECS` (600 s) *and* container CPU below 1 % kills the attempt and
  retries it once. Liveness is read from file mtimes because a healthy agent
  rewrites `agent/<name>.txt` on every step; a present `verifier/` dir relaxes
  the limit 3x, because verifiers can run quiet for many minutes.
  Known limitation: the verifier runs in its **own** container
  (`<trial>__verifier__trial-main-1`, alongside `<trial>__env-main-1`), so the
  CPU probe inspects the env container and reads 0 % during verification. The 3x
  relaxation is what keeps that safe; a future fix should probe both names.
- **`xargs -P` can wedge.** A `bench-run.sh` (`xargs -P 5 -n 2`) was observed
  holding three children and never launching the remaining 27 cells, with two
  slots idle indefinitely. Recovery, and the reason `bench-run2.sh` exists: it
  is idempotent (skips cells that already have a verdict, skips cells that are
  already running) and counts parallelism **globally** from live processes, so
  restarting it tops the run back up to `PAR` without duplicating work.
- **`status.tsv` is a cache, not the record.** A cell can finish without
  appending a row (both causes above), so `report.py` backfills any cell missing
  from the cache by scanning the job dirs for `reward.txt` / `exception.txt`, and
  falls back to the trial's own phase timings when the wall time is unknown.
- **A re-run must not be merged with the attempt it replaced.** The proxy log is
  one append-only stream, the cells of a given (agent, task) share a URL tag, and
  re-running is a first-class operation — so filtering by (agent, task) alone
  silently sums two different attempts (which is exactly what happened when
  opencode was re-run after the `small_model` fix). `report.py` therefore scopes
  each cell's proxy rows to its **current attempt**: every attempt wipes and
  recreates its job dir, so the oldest file in the newest trial dir bounds it.
- **Trim often, not only under pressure.** Deleting layers inside the VM frees
  blocks internally, but the host's sparse datadisk only shrinks when the guest
  issues TRIM — and during a matrix of 1 h cells the per-cell trim in `cell.sh`
  runs far too rarely (the host was losing ~10 GB per 25 min). A trim measured
  **13 GB reclaimed while five trials were running**, so it is safe to do
  concurrently. `watchdog2.sh` therefore trims on every tick rather than waiting
  for a low-disk threshold, and only prunes containers/images below `LOW_MB`.
  Note `docker rmi` cannot remove the image of a *running* container, so pruning
  alone cannot keep up during a long matrix — the trim is the load-bearing part.
- **The scarce resource is the *host* disk, not the VM's.** colima's datadisk
  is a sparse file on the host; when the host filesystem fills, the VM's I/O
  dies mid-write and the box goes catatonic — `docker ps` hangs for minutes,
  `colima ssh` returns `Connection reset by peer`, and running trials fail with
  `OSError: [Errno 5] Input/output error` deep inside pytest. The VM reports
  only 25 GB / 59 GB used while the host is at 99 %, so *looking at the VM is
  actively misleading*: `df -h /System/Volumes/Data` on the host is the only
  number that matters. Recover with `colima stop && colima start`, then
  `docker container prune` + `docker image prune` +
  `colima ssh -- sudo fstrim -v /var/lib/docker` — without the **fstrim the
  sparse file never shrinks**, which is why deleting the VM looks like the only
  option (it is not: trimming reclaimed 32 GB and took the host from 15 GB to
  47 GB free).
- **Each trial leaves a tagged env image behind** (`music-harmony__<id>__env-main:latest`,
  0.4–2 GB each). `docker image prune -f` only removes *dangling* images, so
  these accumulate invisibly. `cell.sh` now removes them explicitly, and
  `watchdog.sh` reaps them whenever free space drops below 9 GB.
- **Reclaiming docker while another cell is pulling an image destroys the pull.**
  The engine used to call `reclaim_async()` on *every* cell finish. That runs
  `docker container/network/image prune -f`, `docker builder prune -f`, `rmi -f`
  on the leftover `*__env-main` images and `colima ssh -- sudo fstrim`. When the
  first cell of a matrix finishes while the other agents are still pulling their
  task image, the prune deletes containerd content out from under the in-flight
  pull and it dies with
  `failed to Lchown ".../clippy-driver" for UID 0, GID 0: no such file or
  directory` (at unpack time) or
  `failed commit on ref "layer-sha256:…": commit failed: rename
  /var/lib/containerd/…/ingest/<id>/data …/blobs/sha256/<digest>: no such file
  or directory` (at commit time).
  This is what took out **all three `vf2-speedup-networkx` cells in `run-0924-1408`**:
  mica's `wal-recovery-ordering` cell finished at 14:15:50, and every vf2 cell —
  all of which were still mid-pull on the 5-layer, ~2 GB rustup image — died at
  14:15:50. It is *not* a concurrency bug in the registry: pull the same image by
  hand with no reclaim running and it succeeds. Two guards now hold it shut:
  reclaim only fires when `Engine.busy()` is false (so it runs once, after the
  last cell), and a single `_RECLAIM_LOCK` keeps any pull from overlapping a
  reclaim left over from a previous run — that leftover is what made a manual
  `docker pull` fail at 14:31 with no matrix running at all.

  The same run is also why **pulling a task image up front is worth it**: three
  cells of one task each pulled the same image independently. `task.toml` pins
  the image for both the agent and the verifier environment
  (`docker_image = "harborframework/terminal-bench:<task>-…@sha256:…"`), and
  harbor *pulls* rather than builds whenever that field is set
  (`should_use_prebuilt_docker_image`). The scheduler now reads those references
  out of `task.toml` (`catalog.task_image_refs`) and pulls them one at a time
  before the task's first cell starts, so the cells' compose `up` finds the image
  already local and skips the pull entirely.

---

## 10. Results log

| Tag | Scope | Notes |
|---|---|---|
| `check1` | 4 agents × `html-js-filter` | first real-task check on the new harness |
| `oracle1` | oracle × 10 tasks | proves each task and its verifier work here |
| `oracle2` | oracle × 3 retries | re-checks after pre-pulling images + raising verifier cap |
| `oracle3` | oracle × `data-anonymization` | re-check after the I/O-error collateral |
| `reg1` | 4 agents × 10 tasks | **INVALID — see below**, destroyed by the host disk filling |
| `reg2` | 4 agents × 9 tasks | the regression matrix (36 cells, 5 in flight) |

### Baseline plumbing checks (pre-proxy)

- `quick-task` (trivial file creation): all four agents reward 1.0.
- Oracle on `quick-task`: reward 1.0.

### `check1` — four agents on `html-js-filter`

| Agent | Reward | Wall | LLM rounds | Note |
|---|---|---|---|---|
| mica | **1** | 19.4 min | 58 | passed |
| kimi-code | 0 | 19.1 min | 79 | verifier failed |
| codex | (killed) | 34 min | 89 | still iterating when stopped, ctx ≈ 190 K |
| opencode | (killed) | 34 min | 107 | still iterating when stopped, ctx ≈ 190 K |

Every cell was attributed correctly in the proxy log by both agent and task,
which is the property the harness exists to provide. codex and opencode were
stopped only because this pre-check inherited the un-capped 8 h agent budget;
`reg1` re-runs them under the 1 h cap.

### `reg1` — INVALID (host disk filled up)

10 tasks × 4 agents = 40 cells, 5 in flight, 1 h agent cap per cell. Only the
first **7** cells are real; everything after that is infrastructure noise and
must not be quoted:

```
mica         session-window-debug   reward 0   596 s
opencode     html-js-filter         reward 0  1250 s
mica         html-js-filter         reward 0  1416 s
kimi-code    html-js-filter         reward 0  1429 s
kimi-code    session-window-debug   reward 0   801 s
codex        session-window-debug   reward 0  2185 s
opencode     session-window-debug   (exception)
```

The remaining ~30 cells `rc=1` after 13–60 s with **no job directory at all** —
harbor could not reach the dying Docker daemon. They are archived under
`runs/reg1.diskfull/` and the job directories were moved aside.

Two traps this exposed in the harness itself, both now fixed:

- `cell.sh` reported those instant failures as `status=ok` because it only
  looked for a missing `exception.txt`. It now treats *no job directory* or a
  non-zero exit as `failed`.
- There was no disk guard at all, so the scheduler kept launching cells into a
  full disk (which is what actually killed the VM). `cell.sh` now refuses to
  start below 8 GB free and reclaims after **every** cell.

### `oracle1` — task validity

The oracle agent runs each task's reference solution. A task that fails oracle
cannot be used to judge an agent, so this runs before the matrix.

| Task | Oracle | Wall | Failure |
|---|---|---|---|
| session-window-debug | 1 | 106 s | |
| html-js-filter | 1 | 849 s | |
| interleaved-vigenere | 1 | 122 s | |
| bun-sourcemap-leak | 1 | 140 s | |
| wal-recovery-ordering | 1 | 693 s | |
| music-harmony | 1 | 138 s | |
| mvcc-lsm-compaction | — | 1151 s | `VerifierTimeoutError: 900 s` — needs a longer verifier budget |
| embedding-drift-monitor | — | 120 s | Docker Hub pull failed (transient) |
| cargo-flight-dispatch | — | 25 s | Docker Hub pull failed (transient) |
| data-anonymization | — | 3669 s | `OSError: [Errno 5] Input/output error` inside pytest — host-disk collateral |

Retried in `oracle2` / `oracle3` after pre-pulling every task image and raising
the verifier budget to `--verifier-timeout-multiplier 4`:

| Task | Oracle | Wall |
|---|---|---|
| embedding-drift-monitor | 1 | 225 s |
| cargo-flight-dispatch | 1 | 128 s |
| data-anonymization | 1 | 917 s |

`data-anonymization` passing in 917 s confirms its earlier 3669 s failure was
purely host-disk collateral, not the task. `mvcc-lsm-compaction` stays excluded:
its verifier needs 900 s+ *with the reference solution*, i.e. it measures the
machine under Rosetta more than the agent. Note `data-anonymization` declares
`[verifier] timeout_sec = 7200`, which at `--verifier-timeout-multiplier 4`
becomes an 8 h ceiling — harmless here (real runs take ~15 min) but worth
knowing if a verifier ever does wedge.
| mvcc-lsm-compaction | — | 8908 s |

Two lessons: **Terminal-Bench tasks ship prebuilt images pinned by digest**
(`docker_image = "harborframework/terminal-bench:<task>-{environment,verifier}-<hash>@sha256:..."`),
so a Docker Hub hiccup looks like a broken task; and **some verifiers need
well over their declared budget on this host**. `mvcc-lsm-compaction` is the
outlier: even the reference solution's verifier runs past 2.5 h (its 900 s
declared budget compiles and runs a C++ suite under Rosetta), so it is
**excluded from the matrix** — it measures the host, not the agent. Every other
task is oracle-valid.

### A single trial is not a measurement

mica ran `html-js-filter` twice on two different matrices:

| Matrix | Result | Detail |
|---|---|---|
| `check1` | reward 1 | both verifier tests passed |
| `reg1` | reward 0 | 1 of 2 tests passed (`tests/test_outputs.py F.`) |

Same agent, same task, same model, opposite outcome. Two consequences for
reading any number in this document:

- **Binary reward at n=1 is noise.** A pass rate needs repeats; where the
  verifier emits `verifier/ctrf.json` (Terminal-Bench does), partial credit is
  the more stable signal — `collect.py` reads it into `partial_pass/partial_total`.
- Token counts vary run to run for the same reason: mica spent 58 rounds on
  this task in `check1` and 37 in `reg1`.

Replicates are separated by **run start time** (`benchmarks/<tag>.started`),
since the proxy log is a single append-only stream. Each replication gets its
own tag, job directories and status file.

### Reading the results

```bash
sort -k1,1 -k2,2 benchmarks/persistence/runs/reg2/status.tsv     # rc / reward / wall
python3 benchmarks/app/legacy/report.py reg2 --cells 36 \
    --tasks "$(cat benchmarks/terminal-bench/tasks.txt)"            # full table -> REPORT.md
python3 benchmarks/app/legacy/collect.py reg2                   # + setup/exec/verify split
python3 benchmarks/app/legacy/summarize.py --log benchmarks/persistence/events.jsonl
python3 benchmarks/app/legacy/summarize.py --errors             # every provider rejection
```

### `reg2` — the 9-task matrix (stopped at 24/36 by request)

9 tasks x 4 agents = 36 cells, 5 concurrent, 1 h agent cap. Tasks were screened
by an oracle run first (see `oracle1`), which is what makes the matrix
interpretable: without it a 0 is indistinguishable from a broken task.

The run was stopped deliberately, so **coverage is uneven**: mica and codex
finished 7 cells each, kimi-code 5, opencode 4. Do not read the cross-agent
means as a clean ranking — use the fair subset below.

Full machine-generated output: `results-reg2.txt` (or `benchmarks/app/legacy/final_summary.py reg2`).

#### All completed cells (binary reward · CTRF partial)

| agent | html-js-filter | session-window-debug | data-anonymization | interleaved-vigenere | wal-recovery-ordering | embedding-drift-monitor | bun-sourcemap-leak |
|---|---|---|---|---|---|---|---|
| mica | 0 · 1/2 | 0 · 4/7 | 0 · 6/8 | 0 · 2/6 | 0 · 95/97 | **1 · 11/11** | 0 · 20/36 |
| codex | 0 · 1/2 | 0 · 5/7 | 0 · 6/8 | 0 · 2/6 | 0 · 94/97 | 0 · 10/11 | 0 · 27/36 |
| opencode | — | 0 · 4/7 | 0 · 0/8 | — | 0 · 95/97 | **1 · 11/11** | — |
| kimi-code | **1 · 2/2** | 0 · 5/7 | 0 · 0/8 | 0 · 2/6 | **1 · 97/97** | — | — |

(`—` = no completed cell. `cargo-flight-dispatch` and `music-harmony` were never
reached by anyone. kimi's `embedding-drift-monitor` has a `reward.txt` but no
`result.json` — its verifier was killed mid-pytest, so it is not a verdict.)

#### Fair subset — the 3 tasks all four agents completed

`session-window-debug`, `data-anonymization`, `wal-recovery-ordering`.
This is the only apples-to-apples comparison in the run.

| agent | mean pass rate | passes | rounds | prompt | output |
|---|---|---|---|---|---|
| **codex** | **81.1 %** | 0 | 168 | 12.0 M | 250.5 K |
| mica | 76.7 % | 0 | 161 | 15.1 M | 318.0 K |
| kimi-code | 57.1 % | 1 | 163 | 18.1 M | 332.9 K |
| opencode | 51.7 % | 0 | 81 | 4.1 M | 175.2 K |

Token efficiency per point of pass rate on that subset: opencode 79 K, codex
148 K, mica 197 K, kimi 317 K.

#### Findings

- **Binary reward is nearly useless here; partial credit is the signal.** Across
  24 scored cells there are 4 passes, and *no agent passes more than one task in
  common* — rank only on the CTRF pass rate. `wal-recovery-ordering` is the
  sharpest example: three agents sit at 94–95/97 and only kimi reaches 97/97, so
  a 1-bit score would call four nearly identical results "all failed".
- **A timeout does not imply a failure, and a non-zero exit does not either.**
  kimi passed `html-js-filter` (2/2) while carrying `AgentTimeoutError` — it had
  already made the workspace correct and kept iterating to the 1 h cap. codex
  still scored 2/6 on `interleaved-vigenere` after `NonZeroAgentExitCodeError`.
  Reward and exception must be read together, which is why both columns exist.
- **Cost does not track score.** On `html-js-filter` codex spent 13.8 M prompt
  tokens to equal mica's 1/2 at 4.1 M (3.4x), and kimi spent 23.9 M to pass.
  Cache-hit rate is ~99 % for every agent, so the difference is **round count**
  (54 vs 110 vs 207), not context size.
- **kimi-code is the token hog and the slowest**: 62.6 M prompt tokens over 6
  cells (2.4x mica's per-cell rate), 2 of 6 cells hitting the 1 h cap, and the
  highest context per round (111 K vs mica 86 K). It is also the only agent with
  2 passes. Slow-but-effective.
- **opencode is the most token-frugal and the cheapest per point**, 81 rounds for
  3 tasks where mica needed 161. But it went 0/8 on `data-anonymization` where
  mica and codex both got 6/8 — it gives up early rather than grinding.
- **Tool shape differs qualitatively, not just in mix.** codex uses exactly two
  tools (`exec_command` 86 %, `write_stdin` 14 %) — its whole interaction model
  is "run a shell command, then feed its stdin". mica spreads across
  `run_shell` 65 % / `read_file` 12 % / `apply_patch` 11 % / `write_file` 7 %;
  opencode and kimi are near-identical to each other (`bash`/`read`/`edit`/`write`).
- **The reasoning-replay hypothesis is dead.** Replaying the identical 367-message
  history with and without reasoning items produced **the same** 99,382 input
  tokens. The earlier correlation was an artifact: reasoning bytes and total
  history bytes are collinear (r=0.998). See `dropReplayedReasoningItems`.

#### Total spend

1767 requests logged by the proxy, 151.3 M prompt tokens (98.9 % cached →
**only 1.61 M uncached**) + 3.79 M output. The 155 M headline is misleading on
its own; almost all of it is cache rereads.

### Run `sw1` — session-window-debug, mica / codex / claude-code

The first run on the new matrix and through the console, so it also serves as the
end-to-end check of the control plane. One task, three agents, parallelism 3
(one cell each), `deepseek-flash` on both wire formats.

| agent | reward | partial (CTRF) | wall | rounds | prompt | cached | output | tools |
|---|---|---|---|---|---|---|---|---|
| mica-code | 0 | 3/7 | 6m 0s | 27 | 1.46 M | 98.9 % | 63.9 k | 76 |
| codex | 0 | **5/7** | 16m 18s | 24 | 1.74 M | 99.1 % | 85.9 k | 54 |
| claude-code | 0 | 4/7 | 15m 20s | 53 | 3.14 M | 98.8 % | 59.3 k | 59 |

All three fail the binary reward and the partial credit separates them — the
same lesson as the wider regression: **read reward and CTRF together**, because
the same agent+task flips between pass and fail across runs.

* **claude-code works on the Anthropic wire format.** 53 rounds over
  `/anthropic/v1/messages`, 98.8 % cache hit, 59 tool calls — the merged
  `message_start`/`message_delta` accounting adds up, and the routing prefix is
  correct (`/anthropic/v1/messages`, not a 404).
* **claude-code is the most expensive and the least efficient.** 2.15× mica's
  prompt tokens and 2× its rounds for one more partial point. Under Rosetta it
  also needed ~12 minutes before its first request (npm install), versus
  minutes for mica's tarball.
* **mica is the fastest and cheapest**, 6 minutes and 1.46 M, and scores lowest
  on partial credit — it stops early rather than grinding, the same shape seen
  with opencode on `data-anonymization` in reg2.
* Two transient upstream `SSLEOFError`s on claude-code's stream, both retried
  and recovered; codex's usual 7 × `GET /responses` 405 capability probes were
  logged as probes, not errors.

Proxy totals for the run: 104 requests, 6.35 M prompt (98.9 % cached), 209 k
output, 189 tool calls.
