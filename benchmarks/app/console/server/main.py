"""Console HTTP server: the control plane's only entry point.

Standard library only, on purpose: this process has to manage docker, harbor and
subprocesses on the user's machine, and a dependency-free server keeps the blast
radius small (the previous read-only dashboard made the same call).

Bind is 127.0.0.1 by default.  The runtime has **no authentication** -- anything
that can reach the port can start processes and read the API key -- so do not
expose it on a LAN interface without understanding that.
"""

from __future__ import annotations

import json
import mimetypes
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import results, settings as settings_mod
from .catalog import AGENTS, AGENTS_BY_ID, list_task_catalog, list_tasks
from .engine import Engine, ensure_dirs, free_mb
from .settings import BENCH_DIR, RUNS_DIR

WEB_DIST = Path(__file__).resolve().parent.parent / "web" / "dist"

ENGINE = Engine(settings_mod.load)
SERVER_STARTED_AT = time.time()


def _payload_state() -> dict:
    settings = settings_mod.load()
    agents = [
        {
            "id": a.id,
            "label": a.label,
            "family": a.family,
            "blurb": a.blurb,
        }
        for a in AGENTS
        if a.id in settings.agents or True
    ]
    return {
        "settings": settings.to_json(),
        "proxy": ENGINE.proxy.status(settings),
        "run": ENGINE.run_state,
        "agents": agents,
        "all_tasks": list_tasks(),
        "task_catalog": list_task_catalog(),
        "runs": results.known_run_tags(),
        "disk_free_mb": free_mb(),
        "log": ENGINE.recent_log(),
        "server_started_at": SERVER_STARTED_AT,
    }


def _payload_results(query: dict[str, list[str]]) -> dict:
    settings = settings_mod.load()

    def pick(name: str, fallback: list[str]) -> list[str]:
        # An absent parameter means "use the saved default"; an explicitly empty
        # one (`tasks=`) means "none selected" and must not fall back, otherwise
        # clearing the task list would still render the default matrix columns.
        if name not in query:
            return fallback
        raw = query.get(name, [])
        return [v for chunk in raw for v in chunk.split(",") if v.strip()]

    agents = [
        a for a in pick("agents", settings.agents) if a in AGENTS_BY_ID
    ]
    tasks = pick("tasks", settings.tasks)
    tag = (query.get("tag") or [None])[0] or results.latest_run_tag()
    return results.build_payload(tag, agents, tasks, ENGINE.running_cells())


def _dispatch(handler: "Handler", method: str, path: str, query: dict, body: dict):
    if path == "/api/health":
        return 200, {
            "ok": True,
            "pid": os.getpid(),
            "uptime": round(time.time() - SERVER_STARTED_AT, 1),
        }
    if path == "/api/state":
        return 200, _payload_state()
    if path == "/api/results":
        return 200, _payload_results(query)
    if path == "/api/settings" and method == "POST":
        # update() coerces, clamps nothing it should not, and persists --
        # including the derived routes.json the proxy hot-reloads and the
        # human-facing env.sh.
        settings_mod.update(body)
        ENGINE._note("settings saved")
        return 200, {"ok": True, "settings": settings_mod.load().to_json()}
    if path == "/api/proxy/start" and method == "POST":
        return 200, ENGINE.proxy.start(settings_mod.load())
    if path == "/api/proxy/stop" and method == "POST":
        return 200, ENGINE.proxy.stop(settings_mod.load())
    if path == "/api/proxy/probe" and method == "GET":
        return 200, _probe_proxy()
    if path == "/api/run/start" and method == "POST":
        settings = settings_mod.load()
        tag = str(body.get("tag") or time.strftime("run-%m%d-%H%M"))
        agents = [a for a in (body.get("agents") or settings.agents) if a in AGENTS_BY_ID]
        tasks = [t for t in (body.get("tasks") or settings.tasks) if t]
        if not agents:
            return 400, {"ok": False, "error": "no agents selected"}
        if not tasks:
            return 400, {"ok": False, "error": "no tasks selected"}
        return 200, ENGINE.start_run(
            tag, int(body.get("parallelism") or settings.parallelism), agents, tasks
        )
    if path == "/api/run/stop" and method == "POST":
        return 200, ENGINE.stop_run(stop_proxy=bool(body.get("stop_proxy")))
    if path == "/api/cell/start" and method == "POST":
        tag = str(body.get("tag") or time.strftime("run-%m%d-%H%M"))
        return 200, ENGINE.start_cell(str(body.get("agent")), str(body.get("task")), tag)
    if path == "/api/cell/stop" and method == "POST":
        return 200, ENGINE.stop_cell(str(body.get("key")))
    if path == "/api/log" and method == "GET":
        key = (query.get("key") or [""])[0]
        return 200, _tail_cell_log(key, int((query.get("tail") or ["200"])[0]))
    if path == "/api/events" and method == "GET":
        limit = int((query.get("limit") or ["80"])[0])
        rows = results.read_events()
        return 200, {"rows": rows[-limit:]}
    return 404, {"error": "not found", "path": path}


def _probe_proxy() -> dict:
    import urllib.error
    import urllib.request

    settings = settings_mod.load()
    url = f"http://127.0.0.1:{settings.proxy_port}/__health"
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            return {"ok": True, "body": json.loads(response.read().decode("utf-8"))}
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
        return {"ok": False, "error": str(exc)}


def _tail_cell_log(key: str, lines: int) -> dict:
    if "__" not in key:
        return {"ok": False, "error": "key must be <agent>__<task>"}
    matches = sorted(RUNS_DIR.glob(f"*/{key}.log"))
    if not matches:
        return {"ok": False, "error": "no log for " + key}
    path = max(matches, key=lambda p: p.stat().st_mtime)
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    # Defence in depth: logs written before redaction existed still hold the key.
    tail = settings_mod.redact(text).splitlines()[-max(1, lines) :]
    return {"ok": True, "path": str(path), "lines": tail}


class Handler(BaseHTTPRequestHandler):
    server_version = "mica-bench-console"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        if self.path.startswith("/api/"):
            return

    # -- plumbing ------------------------------------------------------
    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, payload) -> None:
        self._send(status, json.dumps(payload).encode("utf-8"), "application/json")

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return {}
        return data if isinstance(data, dict) else {}

    def _handle(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        # keep_blank_values matters: `tasks=` (explicitly nothing selected) must
        # stay distinguishable from an absent parameter.
        query = parse_qs(parsed.query, keep_blank_values=True)

        if path.startswith("/api/"):
            body = self._read_body() if method == "POST" else {}
            try:
                status, payload = _dispatch(self, method, path, query, body)
            except Exception as exc:  # noqa: BLE001 - keep the console alive
                status, payload = 500, {"error": f"{type(exc).__name__}: {exc}"}
            self._json(status, payload)
            return
        self._static(path)

    def do_GET(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_HEAD(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    # -- static --------------------------------------------------------
    def _static(self, path: str) -> None:
        if not WEB_DIST.is_dir():
            self._send(
                503,
                (
                    "console/web/dist is missing.\n\n"
                    "build the UI once:\n"
                    "  cd benchmarks/app/console/web && npm install && npm run build\n"
                    "or run the dev server:  npm run dev\n"
                ).encode(),
                "text/plain; charset=utf-8",
            )
            return
        target = (WEB_DIST / path.lstrip("/")).resolve()
        if not str(target).startswith(str(WEB_DIST.resolve())):
            self._send(403, b"forbidden", "text/plain")
            return
        if target.is_dir() or not target.is_file():
            target = WEB_DIST / "index.html"
        if not target.is_file():
            self._send(404, b"not found", "text/plain")
            return
        ctype, _ = mimetypes.guess_type(str(target))
        if ctype in ("text/html", None):
            ctype = "text/html; charset=utf-8"
        elif ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)


class Console(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def serve(host: str, port: int) -> None:
    ensure_dirs()
    settings = settings_mod.load()
    if not settings_mod.SETTINGS_PATH.exists():
        settings_mod.write_route_table(settings.upstream_routes)
    httpd = Console((host, port), Handler)
    print(f"[mica-bench] console on http://{host}:{port}", flush=True)
    print(f"[mica-bench] bench dir {BENCH_DIR}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="mica-bench-console")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=None)
    args = parser.parse_args(argv)
    settings = settings_mod.load()
    serve(args.host, args.port or settings.console_port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
