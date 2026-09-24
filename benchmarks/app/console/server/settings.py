"""Console settings: the single source of truth for the benchmark control plane.

Everything the old shell scaffold kept in ``env.sh`` plus the knobs the web UI is
allowed to change lives here, in ``console/settings.json``.  ``env.sh`` is still
written out for people who want to drive ``run-agent.sh`` by hand, but it is a
*derived* artifact now -- never hand-edit it and expect the console to notice.
"""

from __future__ import annotations

import json
import os
import stat
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

# Directory layout.  ``benchmarks/`` is the benchmark workspace root and holds
# exactly three things, so any path the console needs is derived from this
# file's own location and the whole tree can be moved without touching code:
#
#   benchmarks/
#     app/                the code that runs benchmarks
#                         (console + proxy + runner + agent adapters + artifacts)
#     persistence/        run records (raw logs, harbor jobs, derived tables)
#     terminal-bench/     one benchmark: its task package
#
# ``BENCH_DIR`` is the workspace root, not the console's parent -- those were
# the same directory before the tree was split into app/ and persistence/.
CONSOLE_DIR = Path(__file__).resolve().parent.parent  # <root>/app/console
APP_DIR = CONSOLE_DIR.parent                          # <root>/app
BENCH_DIR = APP_DIR.parent                            # <root>
PERSISTENCE_DIR = BENCH_DIR / "persistence"
SETTINGS_PATH = CONSOLE_DIR / "settings.json"
ENV_SH_PATH = APP_DIR / "env.sh"
PROXY_SCRIPT = APP_DIR / "proxy.py"
# Two different things, deliberately distinguished: the JSONL dataset of every
# upstream request (EVENTS_PATH, the accounting source of truth) and the
# proxied process' own stdout/stderr (PROXY_STDOUT_LOG).  Confusing them is how
# the dataset silently ended up next to proxy.py instead of the run record.
PROXY_STDOUT_LOG = PERSISTENCE_DIR / "proxy.log"
MICA_TARBALL = APP_DIR / "artifacts" / "mica-agent.tar.gz"
RUNS_DIR = PERSISTENCE_DIR / "runs"
JOBS_DIR = PERSISTENCE_DIR / "harbor-jobs"
EVENTS_PATH = PERSISTENCE_DIR / "events.jsonl"
TASKS_ROOT = BENCH_DIR / "terminal-bench" / "tasks"

# Harbour budget multipliers.  ``agent-timeout`` must stay fractional: the flag
# only exists in multiplier form and Terminal-Bench tasks carry an 8 h budget,
# so the default maps to a 1 h ceiling.
DEFAULT_AGENT_TIMEOUT_MULTIPLIER = 0.125
DEFAULT_SETUP_TIMEOUT_MULTIPLIER = 6.0
DEFAULT_VERIFIER_TIMEOUT_MULTIPLIER = 4.0

# Per-agent upstream routing.  ``path_prefix`` is what distinguishes claude-code:
# DeepSeek speaks the Anthropic wire format under ``/anthropic`` and the OpenAI
# one under ``/v1``, and the agent appends its own suffix (``/v1/messages``) to
# the base URL we hand it.
AGENT_UPSTREAMS: dict[str, dict[str, str]] = {
    "mica": {"base": "https://api.deepseek.com", "path_prefix": ""},
    "codex": {"base": "https://api.deepseek.com", "path_prefix": ""},
    "claude-code": {"base": "https://api.deepseek.com", "path_prefix": "/anthropic"},
}

DEFAULT_AGENTS = ["mica", "codex", "claude-code"]

# The nine-task regression matrix, minus mvcc-lsm-compaction (its verifier needs
# over 2.5 h even for the reference solution).
DEFAULT_TASKS = [
    "html-js-filter",
    "session-window-debug",
    "data-anonymization",
    "interleaved-vigenere",
    "wal-recovery-ordering",
    "embedding-drift-monitor",
    "bun-sourcemap-leak",
    "cargo-flight-dispatch",
    "music-harmony",
]


@dataclass
class Settings:
    # --- credentials -----------------------------------------------------
    api_key: str = ""
    api_base: str = "https://api.deepseek.com"
    anthropic_base: str = "https://api.deepseek.com/anthropic"
    model: str = "deepseek-flash"

    # --- matrix ----------------------------------------------------------
    agents: list[str] = field(default_factory=lambda: list(DEFAULT_AGENTS))
    tasks: list[str] = field(default_factory=lambda: list(DEFAULT_TASKS))
    parallelism: int = 5

    # --- runtime ---------------------------------------------------------
    proxy_port: int = 8899
    console_port: int = 8790

    # Guard rails ported from cell2.sh: silence during the agent phase means the
    # cell is dead, but build/install and the verifier are allowed to be quiet
    # for far longer.
    stall_secs: int = 600
    setup_secs: int = 1800
    verify_grace: int = 3
    max_attempts: int = 2
    min_free_mb: int = 8000

    # --- derived / advanced ---------------------------------------------
    # ``None`` means "fall back to AGENT_UPSTREAMS".
    upstreams: dict[str, dict[str, str]] | None = None

    @property
    def upstream_routes(self) -> dict[str, dict[str, str]]:
        routes = {k: dict(v) for k, v in AGENT_UPSTREAMS.items()}
        if self.upstreams:
            for agent, cfg in self.upstreams.items():
                routes.setdefault(agent, {})
                routes[agent].update({k: v for k, v in cfg.items() if v})
        # The claude-code base is configured separately so the UI can expose one
        # "Anthropic base URL" field; keep the route table in sync with it.
        if self.anthropic_base:
            routes.setdefault("claude-code", {})
            routes["claude-code"]["base"] = self.anthropic_base.rsplit("/anthropic", 1)[0]
            routes["claude-code"]["path_prefix"] = "/anthropic"
        if self.api_base:
            for agent in routes:
                if agent != "claude-code":
                    routes[agent]["base"] = self.api_base
        return routes

    # ------------------------------------------------------------------
    def to_json(self) -> dict[str, Any]:
        data = asdict(self)
        data["upstream_routes"] = self.upstream_routes
        return data

    def save(self) -> None:
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = SETTINGS_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(asdict(self), indent=2) + "\n", encoding="utf-8")
        tmp.replace(SETTINGS_PATH)
        os.chmod(SETTINGS_PATH, 0o600)
        write_route_table(self.upstream_routes)
        write_env_sh(self)


def _coerce(raw: dict[str, Any], current: Settings) -> Settings:
    """Apply a partial update, ignoring unknown keys and bad types.

    Deliberately permissive: the UI posts whole objects and a single typo should
    not wipe the rest of the configuration.
    """
    fields = {f for f in Settings.__dataclass_fields__}
    data = asdict(current)
    for key, value in raw.items():
        if key not in fields:
            continue
        if key in ("agents", "tasks") and isinstance(value, list):
            data[key] = [str(v) for v in value if str(v).strip()]
            continue
        if key == "upstreams":
            data[key] = value if isinstance(value, dict) else None
            continue
        default = getattr(current, key)
        if isinstance(default, bool):
            data[key] = bool(value)
        elif isinstance(default, int):
            try:
                data[key] = int(value)
            except (TypeError, ValueError):
                continue
        elif isinstance(default, float):
            try:
                data[key] = float(value)
            except (TypeError, ValueError):
                continue
        else:
            data[key] = str(value)
    return Settings(**data)


def load() -> Settings:
    base = Settings()
    if not SETTINGS_PATH.exists():
        return base
    try:
        raw = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return base
    if not isinstance(raw, dict):
        return base
    return _coerce(raw, base)


def redact(text: str, secret: str | None = None) -> str:
    """Mask credentials before they reach a log file or the browser.

    The engine passes the API key both in the child env *and* as an
    ``--agent-env OPENAI_API_KEY=<key>`` argument, so the raw key otherwise
    lands verbatim in every cell log -- readable from the console UI and by
    anything that can read ``runs/``.
    """
    key = secret if secret is not None else load().api_key
    if not key:
        return text
    return text.replace(key, "***")


def update(patch: dict[str, Any]) -> Settings:
    settings = clamp(_coerce(patch, load()))
    settings.save()
    return settings


def clamp(settings: Settings) -> Settings:
    """Keep the numbers inside ranges the engine can actually honour."""
    settings.parallelism = max(1, min(int(settings.parallelism), 16))
    settings.proxy_port = max(1, min(int(settings.proxy_port), 65535))
    settings.console_port = max(1, min(int(settings.console_port), 65535))
    settings.stall_secs = max(60, int(settings.stall_secs))
    settings.setup_secs = max(60, int(settings.setup_secs))
    settings.verify_grace = max(1, min(int(settings.verify_grace), 20))
    settings.max_attempts = max(1, min(int(settings.max_attempts), 5))
    settings.min_free_mb = max(0, int(settings.min_free_mb))
    return settings


# ---------------------------------------------------------------------------
# Derived artifacts
# ---------------------------------------------------------------------------

ROUTE_TABLE_PATH = CONSOLE_DIR / "routes.json"


def write_route_table(routes: dict[str, dict[str, str]]) -> None:
    """Persist the routing table proxy.py hot-reloads on every request."""
    payload = {"default": {"base": "https://api.deepseek.com", "path_prefix": ""}}
    payload.update(routes)
    tmp = ROUTE_TABLE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    tmp.replace(ROUTE_TABLE_PATH)


def write_env_sh(settings: Settings) -> None:
    """Regenerate ``env.sh`` so manual ``run-agent.sh`` runs stay consistent."""
    lines = [
        "# Generated by console/server/settings.py -- do not edit by hand.",
        "# The console keeps its own copy in console/settings.json and rewrites",
        "# this file on every save so manual runs agree with the web UI.",
        f"export MICA_BENCH_API_KEY={_sh(settings.api_key)}",
        f"export MICA_BENCH_MODEL={_sh(settings.model)}",
        f"export MICA_BENCH_API_BASE={_sh(settings.api_base)}",
        f"export MICA_BENCH_ANTHROPIC_BASE={_sh(settings.anthropic_base)}",
        # Paths are exported rather than recomputed by run-agent.sh so there is
        # exactly one definition of the layout, in this module.
        f"export MICA_BENCH_TASKS={_sh(str(TASKS_ROOT))}",
        f"export MICA_BENCH_JOBS_DIR={_sh(str(JOBS_DIR))}",
        f"export MICA_BENCH_TARBALL={_sh(str(MICA_TARBALL))}",
    ]
    ENV_SH_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(ENV_SH_PATH, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)


def _sh(value: str) -> str:
    return "'" + str(value).replace("'", "'\\''") + "'"
