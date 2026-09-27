#!/usr/bin/env bash
# usage: run-agent.sh <agent> <task-id> [extra harbor args...]
#
# Every upstream request is tagged with both the agent and the task by routing
# through a task-scoped base URL:
#
#     <agent>: http://host.docker.internal:8899/agent_bench/<agent>/task=<task-id>
#
# so the proxy log alone is enough to attribute tokens / rounds to a single
# (agent, task) cell.  Job name is "<agent>__<task>" and the job directory is
# wiped first, which makes every (agent, task) cell re-runnable by id.
set -uo pipefail

AGENT="$1"; shift
TASK="$1"; shift

export PATH="/tmp/harbor-env/bin:$PATH"
# This script lives at <repo>/benchmarks/app/runner/, so the repo root is three
# levels up -- derive it instead of hardcoding an absolute path.
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$APP_DIR/../.." && pwd)"
cd "$REPO" || exit 1
export PYTHONPATH="$REPO"

API_KEY="${MICA_BENCH_API_KEY:?set MICA_BENCH_API_KEY}"
PROXY="http://host.docker.internal:8899/agent_bench/$AGENT/task=$TASK"
# All three paths are exported by ``source app/env.sh`` (which the console
# regenerates from app/console/settings.json); the fallbacks only matter when
# the script is driven entirely by hand.
TASKS="${MICA_BENCH_TASKS:-$REPO/benchmarks/terminal-bench/tasks}"
JOBS_DIR="${MICA_BENCH_JOBS_DIR:-$REPO/benchmarks/persistence/harbor-jobs}"
TARBALL="${MICA_BENCH_TARBALL:-$APP_DIR/artifacts/mica-agent.tar.gz}"
JOBDIR="$JOBS_DIR/${MICA_BENCH_RUN_TAG:-run}__${AGENT}__${TASK}"

# Every agent in the matrix takes the bare model name.  (opencode needed a
# "provider/" prefix, which is one of the reasons it was dropped.)  The name goes
# to the provider verbatim, and `deepseek-flash` is accepted on both the
# OpenAI-compatible and the Anthropic-compatible endpoint.
MODEL="${MICA_BENCH_MODEL:-deepseek-flash}"

rm -rf "$JOBDIR"

COMMON=(
  run
  -p "$TASKS"
  --include-task-name "$TASK"
  --model "$MODEL"
  --n-concurrent 1
  --jobs-dir "$JOBS_DIR"
  --job-name "${MICA_BENCH_RUN_TAG:-run}__${AGENT}__${TASK}"
  # Harbor's Terminal-Bench tasks declare a 28800 s (8 h) agent budget.  Left
  # alone, one wedged cell would hold a parallelism slot for a whole night, so
  # scale it down to a bounded hour per cell.  Setup gets the opposite
  # treatment: npm-installing an agent under Rosetta blows the 360 s default.
  --agent-timeout-multiplier 0.125
  --agent-setup-timeout-multiplier 6
  # Several Terminal-Bench verifiers genuinely need more than their declared
  # budget here (mvcc-lsm-compaction compiles and runs a C++ suite; its 900 s
  # default times out even for the reference solution under Rosetta).
  --verifier-timeout-multiplier 4
  -y
)

ENV_ARGS=(
  --agent-env "OPENAI_BASE_URL=$PROXY"
  --agent-env "OPENAI_API_BASE=$PROXY"
  --agent-env "OPENAI_API_KEY=$API_KEY"
  --agent-env "DEEPSEEK_BASE_URL=$PROXY"
  --agent-env "DEEPSEEK_API_KEY=$API_KEY"
)

case "$AGENT" in
  mica)
    exec harbor "${COMMON[@]}" "${ENV_ARGS[@]}" "$@" \
      --agent "benchmarks.app.agents.mica_code:MicaCode" \
      --agent-kwarg "tarball=$TARBALL"
    ;;
  codex)
    # Codex decides whether it may use *remote* compaction from the provider
    # NAME alone (`ModelProviderInfo::is_openai()` →
    # `capabilities().remote_compaction` in model-provider/src/provider.rs) and
    # there is no config switch for it (openai/codex#24418 is still open).  With
    # a non-OpenAI upstream that branch is wrong twice over: codex pushes a
    # `compaction_trigger` item into an ordinary /responses request and then
    # demands exactly one `{type:"compaction"}` item back.  DeepSeek answers with
    # normal items, so the turn dies with
    #   "Error running remote compact task: ... expected exactly one compaction
    #    output item, got 0 from 3 output items"
    # and `codex exec` exits 1 **mid-task** — the agent is killed while it is
    # still working, which silently truncates any long cell.
    #
    # Harbor's shortcut (`--agent-env OPENAI_BASE_URL=$PROXY`) keeps the provider
    # named "openai", which is what trips this.  Declaring our own provider entry
    # is the documented way to point codex at a third-party model, and it makes
    # codex take the same local-compaction path it uses for any custom provider.
    # The side effect is welcome: custom providers default to
    # `supports_websockets = false`, which also drops the 7 x `GET /responses`
    # 405 capability probes each codex cell used to log.
    #
    # `name` must differ from the built-in `OpenAI` (that string is the whole
    # test) and the key must be a *new* one: `merge_configured_model_providers`
    # uses `or_insert`, so `[model_providers.openai]` cannot override.
    # Same file name as the console's own builder (console/server/harbor.py) so a
    # by-hand cell and a UI cell resolve to the same path.
    CODEX_CONFIG="${TMPDIR:-/tmp}/mica-bench-codex-$TASK.toml"
    cat >"$CODEX_CONFIG" <<EOF
model_provider = "mica-proxy"

[model_providers.mica-proxy]
name = "mica-proxy"
base_url = "$PROXY"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
EOF
    exec harbor "${COMMON[@]}" "${ENV_ARGS[@]}" "$@" --agent codex \
      --agent-kwarg "config=$CODEX_CONFIG"
    ;;
  claude-code)
    # claude-code speaks the Anthropic wire format, so it cannot share ENV_ARGS
    # with the OpenAI-family agents: it reads ANTHROPIC_BASE_URL, and the proxy
    # routes that agent to /anthropic on the same upstream
    # (console/routes.json).
    #
    # HARBOR_ALLOW_INSECURE_MODEL_BASE_URL is required: harbor validates the base
    # URL and refuses plain http, which is what our proxy speaks.
    #
    # claude-code installs itself with npm inside the container, which under
    # amd64 emulation takes ~10 minutes (measured); the setup multiplier below
    # exists to fit that, not because the install needs the budget.  See
    # RUNBOOK.md "为什么 codex / claude-code 的 setup 这么慢" for the fix.
    exec harbor "${COMMON[@]}" "$@" --agent claude-code \
      --agent-env "ANTHROPIC_BASE_URL=$PROXY" \
      --agent-env "ANTHROPIC_API_KEY=$API_KEY" \
      --agent-env "ANTHROPIC_AUTH_TOKEN=$API_KEY" \
      --agent-env "HARBOR_ALLOW_INSECURE_MODEL_BASE_URL=true"
    ;;
  oracle)    exec harbor "${COMMON[@]}" "$@" --agent oracle ;;
  *)         echo "unknown agent: $AGENT" >&2; exit 2 ;;
esac
