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
  codex)     exec harbor "${COMMON[@]}" "${ENV_ARGS[@]}" "$@" --agent codex ;;
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
