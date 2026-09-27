"""Builds the ``harbor run`` invocation for a single cell.

Port of the old ``run-agent.sh``.  Python rather than bash so the engine can own
the child process directly (needed for start/stop from the web UI) and so the
quoting stops being a source of surprise.
"""

from __future__ import annotations

import shlex
import tempfile
from pathlib import Path

from .catalog import AgentSpec
from .catalog import TASKS_ROOT
from .settings import (
    BENCH_DIR,
    DEFAULT_AGENT_TIMEOUT_MULTIPLIER,
    DEFAULT_SETUP_TIMEOUT_MULTIPLIER,
    DEFAULT_VERIFIER_TIMEOUT_MULTIPLIER,
    JOBS_DIR,
    Settings,
)

HARBOR_BIN_DIR = Path("/tmp/harbor-env/bin")
REPO_DIR = Path("/Users/qironglin/Desktop/VsGo-Projects/mica-code")

# ``-p`` is the dataset root: the downloaded Terminal-Bench task package under
# benchmarks/terminal-bench/tasks, *not* the task fixtures next to the agent
# adapters (app/agents/{smoke,quick}-task) -- pointing harbor at those fails with
# "No tasks matched the filter".
DATASET_ROOT = TASKS_ROOT

# The recording proxy is reached from inside the task container, so the host has
# to be the Docker Desktop / colima gateway alias rather than localhost.
PROXY_HOST = "host.docker.internal"


def proxy_url(agent: str, task: str, settings: Settings) -> str:
    """``http://host.docker.internal:<port>/agent_bench/<agent>/task=<task>``.

    Each agent gets its own path so the proxy can attribute every request, and
    ``<agent>`` also selects the upstream route (claude-code -> /anthropic).
    """
    return (
        f"http://{PROXY_HOST}:{settings.proxy_port}"
        f"/agent_bench/{agent}/task={task}"
    )


def build_env(agent: AgentSpec, task: str, settings: Settings) -> dict[str, str]:
    """Credential/routing env for one cell.

    All three agents point at the proxy, never at the real API, so that token and
    round counts come from our own ledger (the user's standing requirement).
    """
    url = proxy_url(agent.id, task, settings)
    key = settings.api_key
    env: dict[str, str] = {}

    if agent.is_anthropic:
        env["ANTHROPIC_BASE_URL"] = url
        env["ANTHROPIC_API_KEY"] = key
        env["ANTHROPIC_AUTH_TOKEN"] = key
    else:
        env["OPENAI_BASE_URL"] = url
        env["OPENAI_API_BASE"] = url
        env["OPENAI_API_KEY"] = key
        env["DEEPSEEK_BASE_URL"] = url
        env["DEEPSEEK_API_KEY"] = key

    for name, value in agent.extra_env:
        env[name] = value
    return env


def codex_provider_config(
    agent: AgentSpec, task: str, settings: Settings
) -> Path | None:
    """Host path of the per-cell Codex ``config.toml``, or None for other agents.

    Codex decides between remote and local compaction from the provider *name*
    alone (``ModelProviderInfo::is_openai()`` -> ``capabilities().remote_compaction``)
    and has no config switch for it (openai/codex#24418 is open).  Harbor's
    shortcut of exporting ``OPENAI_BASE_URL`` leaves the provider named "openai",
    so against a non-OpenAI upstream Codex takes the remote branch wrongly: it
    pushes a ``compaction_trigger`` item into an ordinary ``/responses`` request
    and then demands exactly one ``{"type":"compaction"}`` item back.  DeepSeek
    answers with normal items, so the turn dies with

        Error running remote compact task: ... expected exactly one compaction
        output item, got 0 from 3 output items

    and ``codex exec`` exits 1 **mid-task** -- which silently truncates any cell
    long enough to need compaction.  That is what cut short codex's
    ``vf2-speedup-networkx`` cell in ``vf2-rerun``.

    Declaring our own provider entry is the documented way to point Codex at a
    third-party model, and it makes Codex use the local-compaction path it uses
    for any other custom provider.  Side effect, also welcome: a custom provider
    defaults to ``supports_websockets = false``, which drops the 7 x
    ``GET /responses`` 405 capability probes each codex cell used to log.

    Two things are load-bearing: ``name`` must not be ``OpenAI`` (that string is
    the entire test) and the key must be new, because
    ``merge_configured_model_providers`` uses ``or_insert`` -- redefining
    ``[model_providers.openai]`` cannot override the built-in entry.
    """
    if agent.id != "codex":
        return None
    path = Path(tempfile.gettempdir()) / f"mica-bench-codex-{task}.toml"
    path.write_text(
        'model_provider = "mica-proxy"\n'
        "\n"
        "[model_providers.mica-proxy]\n"
        'name = "mica-proxy"\n'
        f'base_url = "{proxy_url(agent.id, task, settings)}"\n'
        'wire_api = "responses"\n'
        'env_key = "OPENAI_API_KEY"\n',
        encoding="utf-8",
    )
    return path


def build_command(
    agent: AgentSpec,
    task: str,
    settings: Settings,
    run_tag: str,
) -> list[str]:
    """Full argv for ``harbor run`` covering exactly one cell."""
    job_name = f"{run_tag}__{agent.id}__{task}"
    argv = [
        "harbor",
        "run",
        "-p",
        str(DATASET_ROOT),
        "--include-task-name",
        task,
        "--model",
        settings.model,
        "--n-concurrent",
        "1",
        "--jobs-dir",
        str(JOBS_DIR),
        "--job-name",
        job_name,
        "--agent-timeout-multiplier",
        str(DEFAULT_AGENT_TIMEOUT_MULTIPLIER),
        "--agent-setup-timeout-multiplier",
        str(DEFAULT_SETUP_TIMEOUT_MULTIPLIER),
        "--verifier-timeout-multiplier",
        str(DEFAULT_VERIFIER_TIMEOUT_MULTIPLIER),
        "-y",
        "--agent",
        agent.harbor_agent,
    ]

    for name, value in build_env(agent, task, settings).items():
        argv += ["--agent-env", f"{name}={value}"]

    for kwarg in agent.kwargs:
        argv += ["--agent-kwarg", kwarg.format(bench=BENCH_DIR)]

    # Written per cell because the base URL carries the task id, which is what
    # lets the proxy attribute every request to one (agent, task) cell.
    codex_config = codex_provider_config(agent, task, settings)
    if codex_config is not None:
        argv += ["--agent-kwarg", f"config={codex_config}"]

    return argv


def command_line(argv: list[str], env: dict[str, str]) -> str:
    """Human-readable one-liner for the log viewer (secrets redacted)."""
    redacted = {
        k: ("***" if "KEY" in k or "TOKEN" in k else v) for k, v in env.items()
    }
    env_part = " ".join(f"{k}={shlex.quote(v)}" for k, v in redacted.items())
    return f"{env_part} {shlex.join(argv)}".strip()


def cell_job_dir(run_tag: str, agent: str, task: str) -> Path:
    return JOBS_DIR / f"{run_tag}__{agent}__{task}"
