"""Control plane: supervises the recording proxy and the benchmark scheduler.

Port of ``cell2.sh`` + ``bench-run5.sh``.  The reason to move this into Python is
process ownership: the web UI has to be able to *stop* things, which needs real
child-process handles (``start_new_session`` + ``killpg``) instead of the old
``pgrep -f 'cell[0-9]*\\.sh'`` heuristics.  Bash also reads its script lazily by
byte offset, so the old scaffold could not even be edited while it ran.

Policy constants are carried over verbatim from cell2.sh: silent during the agent
phase means dead, but the image build and the verifier are allowed to be quiet
for far longer, and a stall *after* the agent phase is never retried (the agent
budget is already spent; retrying just burns another ~1.7 h to reach the same
place).
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import harbor
from .catalog import AGENTS_BY_ID, JOBS_DIR, task_image_refs
from . import settings as settings_mod
from .settings import (
    APP_DIR,
    CONSOLE_DIR,
    EVENTS_PATH,
    PROXY_STDOUT_LOG,
    PROXY_SCRIPT,
    RUNS_DIR,
    Settings,
)

POLL_SECS = 20
HARBOR_BIN_DIR = Path("/tmp/harbor-env/bin")

# A warm-up pull is one big download; the tasks' images run to a few hundred MB.
# Long enough for a slow link, short enough that a wedged pull cannot pin the
# scheduler for the rest of the day.
IMAGE_PULL_TIMEOUT_SECS = 1800.0

# How long a new run waits for a reclaim left over from the previous one.
# `rmi` of a few GB plus `fstrim` is minutes, not seconds.
RECLAIM_WAIT_SECS = 900.0

# Held while a reclaim pass runs, so pulls and reclaims never overlap.
_RECLAIM_LOCK = threading.Lock()


def _image_present(ref: str) -> bool:
    """True when the pinned image is already in the local daemon.

    The whole reference has to be inspected, digest included: pulling
    ``repo:tag@sha256:...`` stores the image **untagged** in the containerd
    store (``docker images`` shows ``repo:<none>``), so only the digest form
    resolves.  Checking the tag alone reports every cached image as missing and
    would re-pull it on every run.
    """
    try:
        proc = subprocess.run(
            ["docker", "image", "inspect", ref],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return proc.returncode == 0


def _pull_image(ref: str) -> tuple[bool, str]:
    """Pull one pinned image. Returns (ok, last line of output)."""
    try:
        proc = subprocess.run(
            ["docker", "pull", ref],
            capture_output=True,
            text=True,
            timeout=IMAGE_PULL_TIMEOUT_SECS,
        )
    except subprocess.TimeoutExpired:
        return False, f"timed out after {int(IMAGE_PULL_TIMEOUT_SECS)}s"
    except (OSError, subprocess.SubprocessError) as exc:
        return False, str(exc)
    if proc.returncode == 0:
        return True, ""
    detail = (proc.stderr or proc.stdout or "").strip().splitlines()
    return False, detail[-1] if detail else f"docker pull exit {proc.returncode}"


def _short_ref(ref: str) -> str:
    """``repo:tag@sha256:...`` -> ``tag``; the digest adds nothing to a log line."""
    name = ref.split("@", 1)[0]
    return name.rsplit(":", 1)[-1] or name


def _now() -> float:
    return time.time()


def _newest_mtime(paths: list[Path]) -> float:
    newest = 0.0
    for root in paths:
        if root.is_file():
            newest = max(newest, root.stat().st_mtime)
            continue
        if not root.is_dir():
            continue
        for dirpath, _dirs, files in os.walk(root):
            newest = max(newest, Path(dirpath).stat().st_mtime)
            for name in files:
                try:
                    newest = max(newest, (Path(dirpath) / name).stat().st_mtime)
                except OSError:
                    continue
    return newest


def _dir_mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


# proxy
# ---------------------------------------------------------------------------


class ProxySupervisor:
    """Runs ``proxy.py``, the local recording proxy every agent talks to."""

    def __init__(self) -> None:
        self._proc: subprocess.Popen[bytes] | None = None
        self._lock = threading.Lock()

    @property
    def pid(self) -> int | None:
        proc = self._proc
        if proc is None:
            return None
        return proc.pid if proc.poll() is None else None

    def _probe(self, port: int) -> dict | None:
        """Is *something* answering /__health on this port?

        The console is restarted often while a run is in flight, and the proxy
        deliberately outlives it (own process group).  Reporting "not running"
        just because we have no child handle would make the next start fail with
        EADDRINUSE and, worse, let the UI claim the ledger is off.
        """
        import urllib.error
        import urllib.request

        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/__health", timeout=2
            ) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, json.JSONDecodeError):
            return None

    def status(self, settings: Settings) -> dict[str, Any]:
        health = self._probe(settings.proxy_port)
        return {
            "running": self.pid is not None or health is not None,
            "pid": self.pid,
            "external": self.pid is None and health is not None,
            "port": settings.proxy_port,
            "events_path": str(EVENTS_PATH),
            "routes": (health or {}).get("routes") or settings.upstream_routes,
            "log": str(PROXY_STDOUT_LOG),
        }

    def start(self, settings: Settings) -> dict[str, Any]:
        with self._lock:
            if self.pid is not None:
                return {"ok": True, "already": True, "pid": self.pid}
            if self._probe(settings.proxy_port) is not None:
                return {"ok": True, "already": True, "external": True}
            env = dict(os.environ)
            env["PROXY_PORT"] = str(settings.proxy_port)
            env["PROXY_ROUTES"] = str(CONSOLE_DIR / "routes.json")
            # The JSONL dataset path must be explicit: proxy.py's own default
            # is derived from *its* location, so without this the dataset lands
            # beside proxy.py instead of under persistence/.
            env["PROXY_EVENTS"] = str(EVENTS_PATH)
            env["PYTHONUNBUFFERED"] = "1"
            PROXY_STDOUT_LOG.parent.mkdir(parents=True, exist_ok=True)
            handle = PROXY_STDOUT_LOG.open("ab")
            self._proc = subprocess.Popen(
                ["python3", str(PROXY_SCRIPT)],
                cwd=str(APP_DIR),
                env=env,
                stdout=handle,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            time.sleep(0.6)
            if self._proc.poll() is not None:
                return {"ok": False, "error": "proxy exited immediately; see proxy.log"}
            return {"ok": True, "pid": self._proc.pid}

    def stop(self, settings: Settings) -> dict[str, Any]:
        with self._lock:
            proc = self._proc
            if proc is None or proc.poll() is not None:
                self._proc = None
                # No child handle: the proxy was started by an earlier console
                # process (or by hand).  Find whoever holds the port.
                pid = _pid_on_port(settings.proxy_port)
                if pid is None:
                    return {"ok": True, "already": True}
                _terminate_group(pid)
                return {"ok": True, "pid": pid, "external": True}
            pid = proc.pid
            _terminate_group(pid)
            self._proc = None
            return {"ok": True, "pid": pid}


def _pid_on_port(port: int) -> int | None:
    try:
        out = subprocess.run(
            ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
            capture_output=True,
            text=True,
            timeout=15,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.split():
        if line.strip().isdigit():
            return int(line.strip())
    return None


def _terminate_group(pid: int, grace: float = 5.0) -> None:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(os.getpgid(pid), sig)
        except (ProcessLookupError, PermissionError):
            try:
                os.kill(pid, sig)
            except (ProcessLookupError, PermissionError):
                return
        deadline = _now() + grace
        while _now() < deadline:
            if not _alive(pid):
                return
            time.sleep(0.2)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


# ---------------------------------------------------------------------------
# disk / docker reclamation
# ---------------------------------------------------------------------------


def free_mb() -> int | None:
    try:
        usage = shutil.disk_usage("/System/Volumes/Data")
    except OSError:
        try:
            usage = shutil.disk_usage("/")
        except OSError:
            return None
    return int(usage.free / (1024 * 1024))


def reclaim_async() -> None:
    """Reclaim docker artifacts in the background (slow, never blocks a turn).

    Each trial leaves a tagged ``*__env-main`` image behind (0.4-2 GB apiece)
    that ``docker image prune`` never touches because it is tagged -- that is how
    the first run filled the host disk.  ``fstrim`` is what actually shrinks the
    sparse datadisk; without it the image file only ever grows.
    """

    def worker() -> None:
        # One reclaim at a time, and ``wait_for_reclaim`` lets the scheduler hold
        # off until it is done.  Both matter: this deletes images and build cache,
        # and a pull that loses its content out from under it dies with
        # "commit failed: rename ... no such file or directory".
        if not _RECLAIM_LOCK.acquire(blocking=False):
            return
        try:
            _reclaim_pass()
        finally:
            _RECLAIM_LOCK.release()

    threading.Thread(target=worker, name="reclaim", daemon=True).start()


def _reclaim_pass() -> None:
    def run() -> None:
        for cmd in (
            ["docker", "container", "prune", "-f"],
            # Networks matter as much as images: every trial creates its own
            # bridge, and once colima runs out of subnettable address space the
            # *next* cell dies at setup with "all predefined address pools have
            # been fully subnetted" -- which looks like an agent failure and is
            # not one.
            ["docker", "network", "prune", "-f"],
            ["docker", "image", "prune", "-f"],
            ["docker", "builder", "prune", "-f"],
        ):
            _run_quiet(cmd)
        names = _docker_env_main_images()
        for name in names:
            _run_quiet(["docker", "rmi", "-f", name])
        _run_quiet(["colima", "ssh", "--", "sudo", "fstrim", "-v", "/var/lib/docker"])

    run()


def wait_for_reclaim(timeout: float = RECLAIM_WAIT_SECS) -> bool:
    """Block until an in-flight reclaim finishes.  False if it outlasts timeout."""
    if not _RECLAIM_LOCK.acquire(timeout=timeout):
        return False
    _RECLAIM_LOCK.release()
    return True


def _docker_env_main_images() -> list[str]:
    try:
        out = subprocess.run(
            ["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"],
            capture_output=True,
            text=True,
            timeout=30,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [ln.strip() for ln in out.splitlines() if "__env-main" in ln]


def _run_quiet(cmd: list[str]) -> None:
    try:
        subprocess.run(cmd, capture_output=True, timeout=180)
    except (OSError, subprocess.SubprocessError):
        pass


def docker_cpu_pct(name_prefix: str) -> float | None:
    """CPU% of the container whose name starts with ``name_prefix``.

    Used to tell a wedged cell (futex deadlock, 0% CPU) apart from one that is
    legitimately busy compiling.
    """
    try:
        names = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}"],
            capture_output=True,
            text=True,
            timeout=20,
        ).stdout.splitlines()
    except (OSError, subprocess.SubprocessError):
        return None
    target = next((n.strip() for n in names if n.strip().startswith(name_prefix)), None)
    if not target:
        return None
    try:
        out = subprocess.run(
            ["docker", "stats", "--no-stream", "--format", "{{.CPUPerc}}", target],
            capture_output=True,
            text=True,
            timeout=30,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    try:
        return float(out.rstrip("%"))
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# cell supervision
# ---------------------------------------------------------------------------


@dataclass
class CellRun:
    agent: str
    task: str
    log_path: Path
    job_dir: Path
    attempt: int = 1
    pid: int | None = None
    # Hold the Popen, not just the pid: a child we never wait() on stays a
    # zombie, and ``os.kill(pid, 0)`` *succeeds* for a zombie -- so a pid-only
    # liveness check reports a finished cell as running forever (and blocks
    # every later run through busy()).
    proc: subprocess.Popen[bytes] | None = None
    started_at: float = field(default_factory=_now)
    stop_reason: str | None = None
    retry: bool = False

    @property
    def key(self) -> str:
        return f"{self.agent}__{self.task}"

    def alive(self) -> bool:
        if self.proc is None:
            return _alive(self.pid or 0)
        return self.proc.poll() is None

    def snapshot(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "agent": self.agent,
            "task": self.task,
            "pid": self.pid,
            "pid_alive": self.alive(),
            "attempt": self.attempt,
            "started_at": self.started_at,
            "age_secs": round(_now() - self.started_at, 1),
            "log": str(self.log_path),
            "stop_reason": self.stop_reason,
            "heartbeat_age_secs": (
                round(_now() - _newest_mtime([self.job_dir]), 1)
                if _newest_mtime([self.job_dir]) > 0
                else None
            ),
        }


class Engine:
    """Owns the proxy, the scheduler and every running cell."""

    def __init__(self, settings_provider) -> None:
        self._settings = settings_provider
        self.proxy = ProxySupervisor()
        self._lock = threading.RLock()
        self._cells: dict[str, CellRun] = {}
        self._threads: dict[str, threading.Thread] = {}
        self._run: dict[str, Any] | None = None
        self._scheduler: threading.Thread | None = None
        self._log: list[dict[str, Any]] = []

    # -- helpers -------------------------------------------------------
    def _note(self, message: str, level: str = "info") -> None:
        self._log.append({"ts": _now(), "level": level, "message": message})
        del self._log[:-400]

    def recent_log(self, limit: int = 120) -> list[dict[str, Any]]:
        return self._log[-limit:]

    def running_cells(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            return {k: c.snapshot() for k, c in self._cells.items() if c.alive()}

    def busy(self) -> bool:
        with self._lock:
            return any(c.alive() for c in self._cells.values())

    # -- run lifecycle -------------------------------------------------
    @property
    def run_state(self) -> dict[str, Any] | None:
        with self._lock:
            if self._run is None:
                return None
            state = dict(self._run)
        state["active"] = self.busy()
        state["cells"] = self.running_cells()
        state["scheduler_alive"] = bool(
            self._scheduler and self._scheduler.is_alive()
        )
        return state

    def start_run(
        self,
        tag: str,
        parallelism: int,
        agents: list[str],
        tasks: list[str],
    ) -> dict[str, Any]:
        settings = self._settings()
        with self._lock:
            if self.busy():
                return {"ok": False, "error": "a run is already in progress"}
            if not settings.api_key:
                return {"ok": False, "error": "API key is not configured"}
            proxy = self.proxy.status(settings)
            if not proxy["running"]:
                started = self.proxy.start(settings)
                if not started.get("ok"):
                    return started
                self._note(f"proxy started on :{settings.proxy_port}")
            self._run = {
                "tag": tag,
                "parallelism": parallelism,
                "agents": list(agents),
                "tasks": list(tasks),
                "started_at": _now(),
            }
        RUNS_DIR.joinpath(tag).mkdir(parents=True, exist_ok=True)
        (RUNS_DIR / tag / "status.tsv").touch()
        self._scheduler = threading.Thread(
            target=self._scheduler_loop, name="scheduler", daemon=True
        )
        self._scheduler.start()
        self._note(f"run '{tag}' started: {len(agents)} agents x {len(tasks)} tasks")
        return {"ok": True, "tag": tag}

    def stop_run(self, stop_proxy: bool = False) -> dict[str, Any]:
        with self._lock:
            cells = list(self._cells.values())
        for cell in cells:
            self._kill(cell, reason="stopped by user")
        with self._lock:
            self._run = None
        self._note("run stopped by user", "warn")
        if stop_proxy:
            self.proxy.stop()
        return {"ok": True, "stopped": len(cells)}

    def start_cell(self, agent: str, task: str, tag: str) -> dict[str, Any]:
        settings = self._settings()
        if agent not in AGENTS_BY_ID:
            return {"ok": False, "error": f"unknown agent '{agent}'"}
        if not settings.api_key:
            return {"ok": False, "error": "API key is not configured"}
        key = f"{agent}__{task}"
        with self._lock:
            existing = self._cells.get(key)
            if existing is not None and existing.alive():
                return {"ok": False, "error": f"{key} is already running"}
            proxy = self.proxy.status(settings)
        if not proxy["running"]:
            started = self.proxy.start(settings)
            if not started.get("ok"):
                return started
        self._spawn(agent, task, tag)
        return {"ok": True, "key": key}

    def stop_cell(self, key: str) -> dict[str, Any]:
        with self._lock:
            cell = self._cells.get(key)
        if cell is None or not cell.alive():
            return {"ok": False, "error": f"{key} is not running"}
        self._kill(cell, reason="stopped by user")
        return {"ok": True, "key": key}

    # -- scheduler -----------------------------------------------------
    def _scheduler_loop(self) -> None:
        settings = self._settings()
        with self._lock:
            run = dict(self._run or {})
        tag = run["tag"]
        parallelism = int(run["parallelism"])
        agents = list(run["agents"])
        tasks = list(run["tasks"])
        per_agent = max(1, -(-parallelism // max(1, len(agents))))
        pending = [(a, t) for a in agents for t in tasks]
        warmed: set[str] = set()

        self._note(
            f"scheduler: {len(pending)} cells, parallelism {parallelism}, "
            f"max {per_agent} per agent"
        )

        # A reclaim from the previous run deletes images and build cache.  Let it
        # finish first: from here on `busy()` is true, so no new reclaim can
        # start, and every pull below is therefore guaranteed to run alone.
        if not wait_for_reclaim():
            self._note(
                "docker reclaim from a previous run is still going; "
                "image pulls may be slow",
                "warn",
            )

        while True:
            with self._lock:
                if self._run is None:
                    break
            if not pending:
                break

            started_any = False
            i = 0
            while i < len(pending):
                with self._lock:
                    if self._run is None:
                        return
                    cells = list(self._cells.values())
                live = [c for c in cells if c.alive()]
                if len(live) >= parallelism:
                    break
                agent, task = pending[i]
                agent_load = sum(1 for c in live if c.agent == agent)
                if agent_load >= per_agent:
                    i += 1
                    continue
                if self._cell_has_verdict(tag, agent, task):
                    pending.pop(i)
                    continue
                pending.pop(i)
                if task not in warmed:
                    warmed.add(task)
                    self._warm_task_images(task)
                if self._spawn(agent, task, tag):
                    started_any = True
                i = 0
            if not started_any and not pending:
                break
            time.sleep(2 if started_any else POLL_SECS)

        self._note("scheduler: all cells dispatched")

    def _warm_task_images(self, task: str) -> None:
        """Pull this task's pinned images, one at a time, before its cells start.

        The scheduler thread is single-threaded, so doing the pulls here is what
        makes them serial across the whole run.  That is the point: when the
        agents of one task all launch together they each make Docker pull the
        same image, and the concurrent layer extraction fails with
        ``failed to Lchown ... no such file or directory`` -- three of three vf2
        cells died that way.  Once the image is local the cells' compose ``up``
        skips the pull entirely, so this also removes the duplicated download.
        """
        refs = task_image_refs(task)
        if not refs:
            return
        for ref in refs:
            with self._lock:
                if self._run is None:
                    return
            if _image_present(ref):
                continue
            self._note(f"pulling image {_short_ref(ref)} for {task}")
            ok, detail = _pull_image(ref)
            if ok:
                self._note(f"image ready for {task}: {_short_ref(ref)}")
            else:
                # Not fatal: the cell's own compose `up` will retry the pull and
                # report the failure with far more context than we have here.
                self._note(f"image pull failed for {task}: {detail}", "warn")

    def _cell_has_verdict(self, tag: str, agent: str, task: str) -> bool:
        job_dir = JOBS_DIR / f"{tag}__{agent}__{task}"
        attempt = None
        if job_dir.is_dir():
            attempts = sorted(
                p
                for p in job_dir.iterdir()
                if p.is_dir() and p.name.startswith(f"{task}__")
            )
            attempt = attempts[-1] if attempts else None
        if attempt is None:
            return False
        if (attempt / "verifier" / "reward.txt").is_file():
            return True
        result = attempt / "result.json"
        if result.is_file():
            try:
                data = json.loads(result.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return False
            if data.get("exception_info"):
                return True
        return (job_dir / "exception.txt").is_file()

    # -- one cell ------------------------------------------------------
    def _spawn(self, agent: str, task: str, tag: str) -> bool:
        settings = self._settings()
        out_dir = RUNS_DIR / tag
        out_dir.mkdir(parents=True, exist_ok=True)
        avail = free_mb()
        if avail is not None and avail < settings.min_free_mb:
            self._write_status(tag, agent, task, "NA", "NA", 0, "skipped-lowdisk")
            self._note(
                f"skip {agent}__{task}: only {avail}MB free "
                f"(min {settings.min_free_mb}MB)",
                "warn",
            )
            return False

        job_dir = harbor.cell_job_dir(tag, agent, task)
        shutil.rmtree(job_dir, ignore_errors=True)
        log_path = out_dir / f"{agent}__{task}.log"
        cell = CellRun(agent=agent, task=task, log_path=log_path, job_dir=job_dir)
        self._launch(cell, settings, tag)
        with self._lock:
            self._cells[cell.key] = cell
        thread = threading.Thread(
            target=self._supervise, args=(cell, tag), name=f"cell-{cell.key}", daemon=True
        )
        self._threads[cell.key] = thread
        thread.start()
        return True

    def _launch(self, cell: CellRun, settings: Settings, tag: str) -> None:
        spec = AGENTS_BY_ID[cell.agent]
        argv = harbor.build_command(spec, cell.task, settings, tag)
        env = dict(os.environ)
        env["PATH"] = f"{HARBOR_BIN_DIR}:{env.get('PATH', '')}"
        env["PYTHONPATH"] = str(harbor.REPO_DIR)
        env["MICA_BENCH_RUN_TAG"] = tag
        handle = cell.log_path.open("ab")
        handle.write(
            (
                "\n$ "
                + settings_mod.redact(
                    harbor.command_line(
                        argv, harbor.build_env(spec, cell.task, settings)
                    ),
                    settings.api_key,
                )
                + "\n"
            ).encode()
        )
        handle.flush()
        proc = subprocess.Popen(
            argv,
            cwd=str(harbor.REPO_DIR),
            env=env,
            stdout=handle,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
        cell.proc = proc
        cell.pid = proc.pid
        # The child holds its own descriptor; drop ours so a long matrix does
        # not leak one per cell.
        handle.close()
        self._note(f"launched {cell.key} (attempt {cell.attempt}, pid {cell.pid})")

    def _supervise(self, cell: CellRun, tag: str) -> None:
        settings = self._settings()
        in_verifier = False
        try:
            while True:
                if not cell.alive():
                    break
                attempt_dir = self._attempt_dir(cell)
                watched = [cell.log_path, cell.job_dir]
                idle = _now() - _newest_mtime(watched)
                exec_started = bool(
                    attempt_dir and list((attempt_dir / "agent").glob("*.txt"))
                ) if attempt_dir else False
                in_verifier = bool(attempt_dir and (attempt_dir / "verifier").is_dir())

                if in_verifier:
                    limit = settings.stall_secs * settings.verify_grace
                elif exec_started:
                    limit = settings.stall_secs
                else:
                    limit = settings.setup_secs

                if idle > limit:
                    cpu = docker_cpu_pct(attempt_dir.name) if attempt_dir else None
                    if cpu is not None and cpu >= 1.0:
                        time.sleep(POLL_SECS)
                        continue
                    # A stall after the agent phase is terminal: the agent budget
                    # is spent, so a retry only burns another budget to land in
                    # the same place.
                    retry = not in_verifier and cell.attempt < settings.max_attempts
                    self._note(
                        f"{cell.key} stalled (idle {int(idle)}s, cpu {cpu}); "
                        + ("retrying" if retry else "giving up"),
                        "warn",
                    )
                    self._kill(cell, reason="stalled", retry=retry)
                    return
                time.sleep(POLL_SECS)
        finally:
            self._finish(cell, tag)

    def _attempt_dir(self, cell: CellRun) -> Path | None:
        if not cell.job_dir.is_dir():
            return None
        attempts = sorted(
            p
            for p in cell.job_dir.iterdir()
            if p.is_dir() and p.name.startswith(f"{cell.task}__")
        )
        return attempts[-1] if attempts else None

    def _kill(self, cell: CellRun, reason: str, retry: bool = False) -> None:
        if cell.pid:
            _terminate_group(cell.pid)
            attempt = self._attempt_dir(cell)
            if attempt:
                _run_quiet(["docker", "rm", "-f", f"{attempt.name}__env-main-1"])
        cell.stop_reason = reason
        cell.retry = retry
        self._note(f"{cell.key}: {reason}", "warn")

    def _finish(self, cell: CellRun, tag: str) -> None:
        with self._lock:
            self._cells.pop(cell.key, None)
        # Release the log handle the child inherited (we opened it, the child
        # wrote through it; nothing else to do, the fd closes with the child).
        if cell.retry:
            cell.attempt += 1
            cell.started_at = _now()
            cell.stop_reason = None
            with self._lock:
                self._cells[cell.key] = cell
            self._launch(cell, self._settings(), tag)
            thread = threading.Thread(
                target=self._supervise,
                args=(cell, tag),
                name=f"cell-{cell.key}",
                daemon=True,
            )
            self._threads[cell.key] = thread
            thread.start()
            return

        rc, reward, wall, status = self._collect(cell)
        self._write_status(tag, cell.agent, cell.task, rc, reward, wall, status)
        self._note(f"{cell.key} -> {status} (reward {reward}, {wall}s)")
        # Only once nothing else is running.  Reclaiming per cell finish used to
        # fire `docker image/builder prune` and `rmi` while the *other* agents
        # were still pulling their task image, and deleting content out from
        # under an in-flight pull is what killed all three vf2 cells at once:
        # mica's wal cell finished at 14:15:50, and every vf2 cell died at
        # 14:15:50 with "failed to Lchown ... no such file or directory".
        # `busy()` ignores this cell -- its process has already exited -- so the
        # last cell to finish still triggers exactly one reclaim.
        if not self.busy():
            reclaim_async()

    def _collect(self, cell: CellRun) -> tuple[str, str, float, str]:
        wall = round(_now() - cell.started_at, 1)
        attempt = self._attempt_dir(cell)
        if attempt is None:
            return "1", "NA", wall, cell.stop_reason or "failed"
        reward_path = attempt / "verifier" / "reward.txt"
        reward = "NA"
        if reward_path.is_file():
            try:
                reward = reward_path.read_text(encoding="utf-8").strip() or "NA"
            except OSError:
                reward = "NA"
        exc = (cell.job_dir / "exception.txt").is_file()
        if cell.stop_reason == "stalled":
            status = "stalled"
        elif exc:
            status = "exception"
        elif reward != "NA":
            status = "ok"
        else:
            status = "failed"
        return "0", reward, wall, status

    def _write_status(
        self,
        tag: str,
        agent: str,
        task: str,
        rc: str,
        reward: str,
        wall: float,
        status: str,
    ) -> None:
        path = RUNS_DIR / tag / "status.tsv"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"{agent}\t{task}\t{rc}\t{reward}\t{wall}\t{status}\n")


def ensure_dirs() -> None:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
