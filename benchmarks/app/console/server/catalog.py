"""Agent + task catalogue.

The agent list used to be hardcoded in four places (report.py, dashboard.py,
final_summary.py, run-agent.sh).  It lives here now; everything else imports it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .settings import JOBS_DIR, TASKS_ROOT


@dataclass(frozen=True)
class AgentSpec:
    """One agent harness under test.

    ``family`` decides the wire protocol the proxy speaks and therefore which
    credential env vars harbor has to inject; ``harbor_agent`` is the value
    passed to ``harbor run --agent``.
    """

    id: str
    label: str
    family: str  # "openai" | "anthropic"
    harbor_agent: str
    blurb: str
    kwargs: tuple[str, ...] = ()
    extra_env: tuple[tuple[str, str], ...] = ()

    @property
    def is_anthropic(self) -> bool:
        return self.family == "anthropic"


AGENTS: tuple[AgentSpec, ...] = (
    AgentSpec(
        id="mica",
        label="Mica Code",
        family="openai",
        harbor_agent="benchmarks.app.agents.mica_code:MicaCode",
        blurb="本仓库的 agent，经 tarball 注入容器。",
        kwargs=("tarball={bench}/app/artifacts/mica-agent.tar.gz",),
    ),
    AgentSpec(
        id="codex",
        label="Codex CLI",
        family="openai",
        harbor_agent="codex",
        blurb="OpenAI Codex CLI，走 Responses 协议。",
    ),
    AgentSpec(
        id="claude-code",
        label="Claude Code",
        family="anthropic",
        harbor_agent="claude-code",
        blurb="Anthropic Claude Code CLI，经 /anthropic 端点接到 DeepSeek。",
        # harbor refuses a plain-http model base URL unless this opt-out is set;
        # our recording proxy is reached over http://host.docker.internal.
        extra_env=(("HARBOR_ALLOW_INSECURE_MODEL_BASE_URL", "true"),),
    ),
)

AGENTS_BY_ID: dict[str, AgentSpec] = {a.id: a for a in AGENTS}


def list_tasks() -> list[str]:
    """All Terminal-Bench tasks available on disk, sorted."""
    if not TASKS_ROOT.is_dir():
        return []
    return sorted(p.name for p in TASKS_ROOT.iterdir() if (p / "task.toml").is_file())


def task_exists(task: str) -> bool:
    return (TASKS_ROOT / task / "task.toml").is_file()


# ---------------------------------------------------------------------------
# task metadata (category / subcategory / tags)
# ---------------------------------------------------------------------------

# Parsed from each task's task.toml.  The 66 tasks fall into 7 categories, so
# that is the grouping the console exposes; subcategories (33 of them) are far
# too granular to be a first-level filter.
_STR_FIELD = {
    "category": re.compile(r'^category\s*=\s*"([^"]*)"', re.M),
    "subcategory": re.compile(r'^subcategory\s*=\s*"([^"]*)"', re.M),
}

_meta_cache: dict[str, dict[str, object]] = {}


@dataclass(frozen=True)
class TaskMeta:
    name: str
    category: str
    subcategory: str
    tags: tuple[str, ...]

    @property
    def group(self) -> str:
        """First-level bucket shown in the UI."""
        return self.category or "Uncategorised"


def read_task_meta(task: str) -> TaskMeta:
    """Category metadata for one task, cached (task.toml never changes mid-run)."""
    cached = _meta_cache.get(task)
    if cached is None:
        text = ""
        path = TASKS_ROOT / task / "task.toml"
        if path.is_file():
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                text = ""
        values: dict[str, object] = {}
        for key, pattern in _STR_FIELD.items():
            match = pattern.search(text)
            values[key] = match.group(1) if match else ""
        tag_match = re.search(r"^tags\s*=\s*\[([^\]]*)\]", text, re.M)
        values["tags"] = (
            tuple(re.findall(r'"([^"]*)"', tag_match.group(1))) if tag_match else ()
        )
        cached = values
        _meta_cache[task] = cached
    return TaskMeta(
        name=task,
        category=str(cached.get("category") or ""),
        subcategory=str(cached.get("subcategory") or ""),
        tags=tuple(cached.get("tags") or ()),  # type: ignore[arg-type]
    )


# ``task.toml`` pins a prebuilt image for both the agent environment and the
# separate verifier environment.  Harbor *pulls* those instead of building the
# Dockerfile sitting next to them: ``should_use_prebuilt_docker_image`` returns
# True as soon as ``docker_image`` is set.  That matters because the pull is the
# fragile step -- several cells of the same task starting together ask Docker for
# the same image at once and the concurrent layer extraction corrupts the image
# store (``failed to Lchown ... no such file or directory``).  The engine pulls
# them one at a time up front; see ``Engine._warm_task_images``.
_DOCKER_IMAGE_RE = re.compile(r'^\s*docker_image\s*=\s*"([^"]*)"')

_image_cache: dict[str, tuple[str, ...]] = {}


def task_image_refs(task: str) -> tuple[str, ...]:
    """Prebuilt image references for one task, agent environment first."""
    cached = _image_cache.get(task)
    if cached is None:
        found: list[tuple[str, str]] = []
        path = TASKS_ROOT / task / "task.toml"
        if path.is_file():
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                text = ""
            section = ""
            for line in text.splitlines():
                stripped = line.strip()
                if stripped.startswith("["):
                    section = stripped
                    continue
                match = _DOCKER_IMAGE_RE.match(line)
                if match:
                    found.append((section, match.group(1)))
        # Agent environment first: without that image no cell can start at all.
        found.sort(key=lambda item: item[0].startswith("[verifier"))
        ordered: list[str] = []
        for _, ref in found:
            if ref not in ordered:
                ordered.append(ref)
        cached = tuple(ordered)
        _image_cache[task] = cached
    return cached


# Display order for the task groups: biggest / most familiar first.
CATEGORY_ORDER: tuple[str, ...] = (
    "Software",
    "ML",
    "Science",
    "Operations",
    "Security",
    "Hardware",
    "Media",
)


def list_task_catalog() -> list[dict[str, object]]:
    """Every task with its category metadata, in stable (category, name) order."""
    metas = [read_task_meta(t) for t in list_tasks()]
    rank = {name: i for i, name in enumerate(CATEGORY_ORDER)}
    metas.sort(key=lambda m: (rank.get(m.group, len(rank)), m.group, m.name))
    return [
        {
            "name": m.name,
            "category": m.category,
            "group": m.group,
            "subcategory": m.subcategory,
            "tags": list(m.tags),
        }
        for m in metas
    ]
