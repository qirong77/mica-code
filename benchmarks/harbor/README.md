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
MICA_TARBALL=~/mica-bench/mica-agent.tar.gz

# 2. Run Mica on a couple of Terminal-Bench tasks.
harbor run -d terminal-bench/terminal-bench@latest \
  --agent benchmarks.harbor.mica_code:MicaCode \
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
`benchmarks.harbor.mica_code` resolves.

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
  && (cd /tmp/stage && tar -czf ~/mica-bench/mica-agent.tar.gz .)

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
- Working smoke task: `harbor run --path benchmarks/harbor/smoke-task` exercises
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

## Tests

```sh
/tmp/harbor-env/bin/python -m pytest benchmarks/harbor/test_mica_code.py
```
