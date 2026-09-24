# Running Mica Code on Terminal-Bench (Harbor)

Scores Mica Code against other coding agents (`codex`, `claude-code`, ...) on
[Harbor](https://github.com/harbor-framework/harbor) / Terminal-Bench, using the
same model for every agent so that only the *harness* differs.

## Why `mica exec` accepts codex-style flags

`mica exec` deliberately accepts the `codex exec` CLI contract verbatim:
`--dangerously-bypass-approvals-and-sandbox`, `--skip-git-repo-check`,
`--cd`, `--enable <feature>`, `-c model_reasoning_effort=<effort>`,
`-c model_reasoning_summary=<mode>`, a `--` separator and a trailing bare
prompt. Unknown `-c` keys are ignored rather than rejected, and codex's
`minimal`/`max` effort values fold onto mica's `low`/`xhigh`.

This means harnesses that drive a `codex`-shaped CLI can drive Mica with almost
no glue. Note that Harbor's built-in `--agent codex` still installs the *real*
Codex CLI, so benchmarking Mica needs the custom agent below.

## Credentials

The agent does not write a config file. Harbor's `--agent-env` is used instead:
Mica synthesizes a runtime-only `openai` provider from `OPENAI_API_KEY` /
`OPENAI_BASE_URL` when the on-disk config carries no api_key
(`packages/mica-config/envProvider.ts`). That provider is never persisted, and
any provider already configured on disk disables the synthesis.

Because the provider id is always `openai`, the model must be passed
provider-qualified: `--model openai/<model>`.

## Quick start

```sh
# 1. Point MICA at a build the container can execute (see "Architecture").
MICA_TARBALL=benchmarks/app/artifacts/mica-agent.tar.gz

# 2. Run Mica on a couple of Terminal-Bench tasks.
harbor run -d terminal-bench/terminal-bench@latest \
  --agent benchmarks.app.agents.mica_code:MicaCode \
  --agent-kwarg tarball="$MICA_TARBALL" \
  --agent-env OPENAI_API_KEY=sk-... \
  --agent-env OPENAI_BASE_URL=https://api.example.com/v1 \
  --model openai/<model> \
  --jobs-dir "$HOME/harbor-jobs" \
  -l 3

# 3. Same tasks, same model, built-in codex agent.
harbor run -d terminal-bench/terminal-bench@latest \
  --agent codex \
  --agent-env OPENAI_API_KEY=sk-... \
  --agent-env OPENAI_BASE_URL=https://api.example.com/v1 \
  --model <model> \
  --jobs-dir "$HOME/harbor-jobs" \
  -l 3
```

`--agent` accepts an import path directly (it replaced the deprecated
`--agent-import-path`). The repo root must be on `PYTHONPATH` so that
`benchmarks.app.agents.mica_code` resolves.

## Agent options

| kwarg | meaning |
|---|---|
| `tarball` | Local archive containing the `mica` binary at its root, or `mica-linux-{x64,arm64}` for a multi-arch archive. When omitted, the published GitHub release is downloaded via `install.sh`. |
| `repo` | GitHub `owner/name` for release downloads (default `qirong77/mica-code`). |
| `version` | Release tag to install (default `latest`). |
| `reasoning_effort` | Compiled to `-c model_reasoning_effort=<value>` (mica folds this onto `--variant`). |
| `thinking` | Adds `--thinking`, emitting reasoning items in the exec stream. |
| `max_turns` | Adds `--max-turns <n>`. |

## Architecture: pick the binary the container can actually run

`mica` is a `bun build --compile` binary, so it is architecture-specific.

**Bun's x86-64 binary crashes with SIGILL (exit 132) under qemu emulation.**
Terminal-Bench's prebuilt images are `amd64`-only, so on an arm64 host the
container is emulated and the x64 binary dies during `mica --version`. Build an
archive for the container's native architecture instead:

```sh
# Native arm64 archive (run tasks with --force-build so images match the host).
MICA_PREBUILD_DONE=1 MICA_BUILD_TARGET=bun-linux-arm64 \
  MICA_BUILD_OUTFILE=dist/release/mica-code-linux-arm64 bun scripts/build.mjs

mkdir -p /tmp/stage && cp dist/release/mica-code-linux-arm64 /tmp/stage/ \
  && (cd /tmp/stage && tar -czf benchmarks/app/artifacts/mica-agent.tar.gz .)

harbor run -d terminal-bench/terminal-bench@latest --force-build ...
```

`--force-build` makes Harbor build each task's `Dockerfile` locally (the task
packages ship one), yielding images that match the host architecture rather
than pulling amd64 prebuilt images.

Build the x64 archive the same way with `bun-linux-x64`, or ship both binaries
in one archive as `mica-linux-x64` / `mica-linux-arm64` and let the installer
pick via `uname -m` inside the container.

The archive intentionally carries no `node-pty` runtime, so Mica's PTY tools are
unavailable inside the benchmark container; Terminal-Bench does not use them.
Build with `scripts/package-release.mjs` on a matching host if you need them.

## Local pitfalls (colima on macOS)

- The jobs directory must live under `$HOME`. colima does not share the host's
  `/tmp`, so a `--jobs-dir /tmp/...` bind mount silently becomes an empty
  directory and every `/logs/**` write — including the verifier's reward file —
  is lost.
- `docker compose` and `docker buildx` are separate plugins:
  `brew install docker-compose docker-buildx` and add
  `"cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]` to
  `~/.docker/config.json`. Without compose, Harbor fails with
  `unknown flag: --project-name`.
- Working smoke task: `harbor run --path benchmarks/app/agents/smoke-task` exercises
  install → run → usage → verifier on one trivial task.

## Usage reporting

`populate_context_post_run` parses `turn.completed` events from the exec stream
and maps them onto Harbor's counters:

| Harbor | mica `turn.completed.usage` |
|---|---|
| `n_input_tokens` | `input_tokens + cached_input_tokens` (mica reports the non-cached part only) |
| `n_cache_tokens` | `cached_input_tokens` |
| `n_output_tokens` | `output_tokens` |

`cost_usd` is left unset: mica does not emit pricing.

The ATIF `trajectory.json` is intentionally not produced yet. It is optional for
Harbor (only the Trajectory viewer and trajectory-seeded runs need it), so a
first comparison does not require it.

## Comparing several agents on one model

Harbor's built-in `codex` and `claude-code` agents and this `mica` adapter can
be run against the same model, but each wants a different shape of the same two
things — the model string and the base URL. Getting these wrong is silent: an
agent may still finish the task while talking to a *different* endpoint, or it
may fail every request and still exit 0.

The current comparison set is `mica` / `codex` / `claude-code`. Two earlier
entrants, `opencode` and `kimi-code`, were dropped: opencode silently bypassed
the proxy whenever its provider was not one of `openai`/`anthropic`/`google`,
and kimi-code measured the same thing as the others at a much higher setup cost.

### Route every agent through one logging proxy

`benchmarks/app/proxy.py` listens on `:8899` and maps
`/agent_bench/<agent>/<path>` onto `<upstream>/<path>`, recording one JSONL
line per request plus the upstream `usage` block:

```sh
python3 benchmarks/app/proxy.py          # PROXY_UPSTREAM=https://api.deepseek.com
```

Containers reach it at `host.docker.internal:8899` (colima resolves this to the
VM gateway, e.g. `192.168.5.2`). Point each agent at its own prefix so requests
are attributable without guessing, then aggregate:

```sh
python3 benchmarks/app/legacy/summarize.py      # per-agent reqs / tokens / cache% / peak ctx
```

Streaming (`text/event-stream`) and non-streaming responses are both parsed;
`accept-encoding` is stripped on the way out so bodies stay readable.

### Model-string shape differs per agent

| Agent | What it needs | Why |
|---|---|---|
| `mica` | bare (`deepseek-flash`) | the adapter pairs it with its own provider id |
| `codex` | bare | forwards the name to the provider, which rejects a prefix |
| `claude-code` | bare | goes into `ANTHROPIC_MODEL`; the adapter also pins every tier alias (`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`) to it, or the CLI would resolve `opus`/`sonnet` to a real Anthropic model |

This is why the adapter takes a `provider` option: Harbor hands over a qualified
`provider/model` string, but mica's provider ids are its own (its defaults
include a credential-less `deepseek`), so the prefix is stripped and the
credentialed provider is substituted.

### Signals the proxy surfaced

- `codex` issues `GET /responses` probes that the upstream answers with `405`;
  harmless (it proceeds) but it inflates request counts.

Matching per-agent request counts against Harbor's reported usage is the only
way to notice this: codex still scores `reward=1`.

### Faster setup

`codex` and `claude-code` are installed **inside every container, at run time**
— `apt-get install nodejs npm`, then `nvm install 22` + `npm i -g @openai/codex`
for codex, or the `bootstrap.sh` download for claude-code. Measured on the same
task and host, that install is ~10 min and accounts for two thirds of the cell's
wall clock (mica ships a prebuilt binary in the tarball, which is why its setup
is ~0).

The cheap fix is to stop paying it per cell: base the task image on
`node:22-alpine` (skips nvm entirely), pre-bake the agent into the image so
Harbor's own "already installed" check short-circuits `install()`, or at minimum
share an npm cache volume across cells. Full measurements and the ranked options
are in [`../../RUNBOOK.md`](../../RUNBOOK.md) § "Setup cost".

## Tests

```sh
/tmp/harbor-env/bin/python -m pytest benchmarks/app/agents/test_mica_code.py
```
