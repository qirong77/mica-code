#!/usr/bin/env python3
"""
Per-agent, per-task LLM proxy with structured request logging.

Route:
    POST http://<host>:<port>/agent_bench/<agent>/task=<task>/<upstream-path>
      ->  log request shape
      ->  forward to  <PROXY_UPSTREAM>/<upstream-path>
      ->  log response usage / tool calls / latency

Both `/agent_bench/<agent>/...` (no task) and the `task=` form are accepted.
The `task=` segment is what makes every upstream request attributable to a
single benchmark task without having to parse prompts.

Env:
  PROXY_PORT         listen port        (default 8899)
  PROXY_UPSTREAM     upstream origin    (default https://api.deepseek.com)
  PROXY_EVENTS       JSONL log path     (default <script dir>/../persistence/
                     events.jsonl; PROXY_LOG is still accepted as an alias)
  PROXY_SAVE_BODIES  "1" to dump raw request bodies under <log dir>/raw/
  PROXY_ROUTES       JSON table mapping agent -> {base, path_prefix} (optional).
                     Re-read whenever its mtime changes, so the console can
                     repoint an agent without restarting the proxy.  Agents
                     speaking the Anthropic wire format (claude-code) need
                     path_prefix "/anthropic"; everything else uses "".
"""

import json
import os
import threading
import time
import http.client
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

UPSTREAM = os.environ.get("PROXY_UPSTREAM", "https://api.deepseek.com")
PORT = int(os.environ.get("PROXY_PORT", "8899"))

# This script lives at benchmarks/app/proxy.py and the run record belongs under
# benchmarks/persistence/, so the default is "two levels up, in persistence".
# It is duplicated (not imported) on purpose: proxy.py is deliberately
# standalone -- it must run without the console package.  The console always
# passes PROXY_EVENTS explicitly, from settings.py, which owns the layout.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_EVENTS = os.path.join(
    os.path.dirname(_SCRIPT_DIR), "persistence", "events.jsonl"
)
LOG_PATH = (
    os.environ.get("PROXY_EVENTS")
    or os.environ.get("PROXY_LOG")
    or _DEFAULT_EVENTS
)
SAVE_BODIES = os.environ.get("PROXY_SAVE_BODIES") == "1"
RAW_DIR = os.path.join(os.path.dirname(os.path.abspath(LOG_PATH)), "raw")
ROUTES_PATH = os.environ.get("PROXY_ROUTES", "")

PREFIX = "/agent_bench/"
_lock = threading.Lock()
_seq = Counter()          # (agent, task) -> request ordinal, so "round N" is stable
_stats = Counter()        # cheap health counters

_up = urlparse(UPSTREAM)
UP_HOST = _up.hostname
UP_PORT = _up.port or (443 if _up.scheme == "https" else 80)
UP_TLS = _up.scheme == "https"
UP_BASE = _up.path.rstrip("/")

_routes_cache = {"mtime": -1.0, "table": {}}


def _load_routes():
    """Agent -> upstream spec, hot-reloaded when the file changes."""
    if not ROUTES_PATH:
        return {}
    try:
        mtime = os.path.getmtime(ROUTES_PATH)
    except OSError:
        return _routes_cache["table"]
    with _lock:
        if mtime != _routes_cache["mtime"]:
            try:
                with open(ROUTES_PATH, encoding="utf-8") as fh:
                    table = json.load(fh)
                _routes_cache["table"] = table if isinstance(table, dict) else {}
                _routes_cache["mtime"] = mtime
            except (OSError, ValueError):
                # Keep the last good table: a torn write must not break routing.
                pass
        return _routes_cache["table"]


def _join_path(base_path, prefix):
    base_path = (base_path or "").rstrip("/")
    prefix = (prefix or "").rstrip("/")
    if not prefix:
        return base_path
    if base_path.endswith(prefix):
        return base_path
    return base_path + prefix


def resolve_upstream(agent):
    """(host, port, tls, path_prefix) for one agent, falling back to default."""
    table = _load_routes()
    spec = table.get(agent) or table.get("default") or {}
    base = spec.get("base") or UPSTREAM
    parsed = urlparse(base)
    if not parsed.hostname:
        return UP_HOST, UP_PORT, UP_TLS, UP_BASE
    return (
        parsed.hostname,
        parsed.port or (443 if parsed.scheme == "https" else 80),
        parsed.scheme == "https",
        _join_path(parsed.path, spec.get("path_prefix")),
    )


def log_record(rec):
    line = json.dumps(rec, ensure_ascii=False)
    with _lock:
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")


def next_seq(agent, task):
    with _lock:
        _seq[(agent, task)] += 1
        return _seq[(agent, task)]


def split_route(path):
    """Path -> (agent, task, upstream_path).

    /agent_bench/mica/task=html-js-filter/responses -> ("mica", "html-js-filter", "/responses")
    /agent_bench/mica/responses                     -> ("mica", None, "/responses")
    """
    agent, task, rest = "unknown", None, path
    if path.startswith(PREFIX):
        tail = path[len(PREFIX):]
        agent, _, rest = tail.partition("/")
        agent = unquote(agent) or "unknown"
        rest = "/" + rest
        if rest.startswith("/task="):
            seg, _, after = rest[1:].partition("/")
            task = unquote(seg[len("task="):]) or None
            rest = "/" + after
    return agent, task, rest


def describe_request(body: bytes, content_type: str):
    """What the agent actually sent: message/item counts, tool history, media."""
    info = {"req_bytes": len(body)}
    ct = (content_type or "").lower()
    if "json" not in ct and body[:1] not in (b"{", b"["):
        return info
    try:
        payload = json.loads(body)
    except Exception:
        return info
    if not isinstance(payload, dict):
        return info

    info["model"] = payload.get("model")
    info["stream"] = bool(payload.get("stream"))
    for src, dst in (("max_output_tokens", "max_output_tokens"),
                     ("max_completion_tokens", "max_output_tokens"),
                     # Anthropic spells it max_tokens.
                     ("max_tokens", "max_output_tokens"),
                     ("temperature", "temperature"),
                     ("reasoning", "reasoning_cfg"),
                     ("tools", "tools_declared")):
        if src in payload:
            v = payload[src]
            info[dst] = len(v) if isinstance(v, list) else v

    # Anthropic hoists the system prompt out of the message list.
    system = payload.get("system")
    if system is not None:
        info["system_bytes"] = len(
            system if isinstance(system, str) else json.dumps(system, ensure_ascii=False)
        )

    items = payload.get("input")
    msgs = payload.get("messages")
    if isinstance(items, list):
        info["mode"] = "responses"
        kinds = Counter()
        tool_calls = tool_outputs = images = 0
        system_bytes = 0
        for it in items:
            if isinstance(it, str):
                kinds["text_str"] += 1
                continue
            if not isinstance(it, dict):
                continue
            t = str(it.get("type") or it.get("role") or "unknown")
            kinds[t] += 1
            if t in ("function_call", "tool_use"):
                tool_calls += 1
            elif t in ("function_call_output", "tool_result"):
                tool_outputs += 1
            elif t in ("input_image", "image_url", "image"):
                images += 1
            if t in ("message", "input_text") or it.get("role") == "system":
                blob = json.dumps(it, ensure_ascii=False)
                if it.get("role") == "system":
                    system_bytes += len(blob)
        info["input_count"] = len(items)
        info["kinds"] = dict(kinds)
        info["history_tool_calls"] = tool_calls
        info["history_tool_outputs"] = tool_outputs
        info["image_refs"] = images
        info["reasoning_items"] = kinds.get("reasoning", 0)
        if system_bytes:
            info["system_bytes"] = system_bytes
    elif isinstance(msgs, list):
        # Same key, two very different shapes.  Anthropic carries typed content
        # blocks (text / tool_use / tool_result / image) and hoists `system`;
        # OpenAI carries a flat role/content pair with `tool_calls` alongside.
        info["mode"] = "anthropic_messages" if system is not None else "chat_completions"
        info["input_count"] = len(msgs)
        kinds = Counter()
        tool_calls = tool_outputs = images = 0
        for m in msgs:
            if not isinstance(m, dict):
                continue
            role = str(m.get("role", "?"))
            kinds[role] += 1
            if role == "tool":
                tool_outputs += 1
            if m.get("tool_calls"):
                tool_calls += len(m["tool_calls"])
            content = m.get("content")
            if isinstance(content, list):
                for part in content:
                    if not isinstance(part, dict):
                        continue
                    ptype = part.get("type")
                    if ptype in ("image_url", "image"):
                        images += 1
                    elif ptype == "tool_use":
                        tool_calls += 1
                    elif ptype == "tool_result":
                        tool_outputs += 1
        info["kinds"] = dict(kinds)
        info["history_tool_calls"] = tool_calls
        info["history_tool_outputs"] = tool_outputs
        info["image_refs"] = images
    return info


def _usage_out(u):
    """Normalise usage to one shape across all three wire formats.

    The conventions disagree about whether the cache is *inside* the input
    count, and mixing them silently makes one agent look an order of magnitude
    cheaper:

      * OpenAI / DeepSeek chat_completions -- ``prompt_tokens`` already
        includes the cached part, which is reported separately as
        ``prompt_cache_hit_tokens``.
      * Anthropic -- ``input_tokens`` *excludes* the cache; the cached part is
        ``cache_read_input_tokens`` (reused) plus ``cache_creation_input_tokens``
        (written this call).

    Everything is emitted OpenAI-style: ``input`` is the true total context and
    ``cached`` is the subset that was served from cache.
    """
    cached = None
    anthropic = u.get("cache_read_input_tokens") is not None
    if anthropic:
        read = int(u.get("cache_read_input_tokens") or 0)
        created = int(u.get("cache_creation_input_tokens") or 0)
        raw_in = int(u.get("input_tokens") or 0)
        inp = raw_in + read + created
        cached = read
    else:
        inp = u.get("input_tokens", u.get("prompt_tokens"))
        for key in ("input_tokens_details", "prompt_tokens_details"):
            d = u.get(key)
            if isinstance(d, dict) and d.get("cached_tokens") is not None:
                cached = d["cached_tokens"]
        if cached is None and u.get("prompt_cache_hit_tokens") is not None:
            cached = u["prompt_cache_hit_tokens"]

    out = u.get("output_tokens", u.get("completion_tokens"))
    reasoning = None
    if isinstance(u.get("output_tokens_details"), dict):
        reasoning = u["output_tokens_details"].get("reasoning_tokens")
    elif isinstance(u.get("completion_tokens_details"), dict):
        reasoning = u["completion_tokens_details"].get("reasoning_tokens")
    return {"input": inp, "cached": cached, "output": out,
            "reasoning": reasoning, "total": u.get("total_tokens")}


def _merge_usage(acc, new):
    """Shallow-merge two usage dicts, newer keys winning.

    Streaming protocols split the usage report across events (Anthropic puts
    input tokens in ``message_start`` and output tokens in ``message_delta``),
    so replacing instead of merging would drop half the accounting.
    """
    if not isinstance(new, dict):
        return acc
    if not isinstance(acc, dict):
        return dict(new)
    merged = dict(acc)
    merged.update({k: v for k, v in new.items() if v is not None})
    return merged


def describe_response(raw: bytes, content_type: str, ttfb_ms):
    """Usage + how many tool calls the model issued + why it stopped."""
    res = {"ttfb_ms": ttfb_ms}
    ct = (content_type or "").lower()
    tool_calls = 0
    tool_names = []
    finish = None
    usage = None
    text_bytes = 0
    thinking_bytes = 0
    err = None

    if "event-stream" in ct:
        for line in raw.split(b"\n"):
            line = line.strip()
            if not line.startswith(b"data:"):
                continue
            chunk = line[5:].strip()
            if not chunk or chunk == b"[DONE]":
                continue
            try:
                evt = json.loads(chunk)
            except Exception:
                continue
            if not isinstance(evt, dict):
                continue
            et = evt.get("type")
            if et in ("response.completed", "response.done"):
                resp = evt.get("response") or {}
                if isinstance(resp, dict):
                    if resp.get("usage"):
                        usage = _merge_usage(usage, resp["usage"])
                    out = resp.get("output")
                    if isinstance(out, list):
                        tool_calls += sum(1 for o in out
                                          if isinstance(o, dict) and o.get("type") == "function_call")
                        for o in out:
                            if isinstance(o, dict) and o.get("type") == "function_call" and o.get("name"):
                                tool_names.append(str(o["name"]))
            elif et == "response.output_item.done":
                item = evt.get("item") or {}
                if isinstance(item, dict) and item.get("type") == "function_call":
                    tool_calls += 1
                    if item.get("name"):
                        tool_names.append(str(item["name"]))
            elif et == "response.output_text.delta":
                text_bytes += len(evt.get("delta") or "")
            elif et == "response.failed":
                err = json.dumps((evt.get("response") or {}).get("error"))[:400]

            # --- Anthropic Messages streaming -------------------------------
            # Claude Code drives this shape.  Anthropic reports input tokens
            # only in message_start and output tokens only in message_delta,
            # so the two halves have to be merged rather than replaced.
            elif et == "message_start":
                message = evt.get("message") or {}
                if isinstance(message, dict) and isinstance(message.get("usage"), dict):
                    usage = _merge_usage(usage, message["usage"])
            elif et == "content_block_start":
                block = evt.get("content_block") or {}
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    tool_calls += 1
                    if block.get("name"):
                        tool_names.append(str(block["name"]))
            elif et == "content_block_delta":
                delta = evt.get("delta") or {}
                if isinstance(delta, dict):
                    if delta.get("type") == "text_delta":
                        text_bytes += len(delta.get("text") or "")
                    elif delta.get("type") == "thinking_delta":
                        thinking_bytes += len(delta.get("thinking") or "")
            elif et == "message_delta":
                if isinstance(evt.get("usage"), dict):
                    usage = _merge_usage(usage, evt["usage"])
                delta = evt.get("delta") or {}
                if isinstance(delta, dict) and delta.get("stop_reason"):
                    finish = delta["stop_reason"]

            if isinstance(evt.get("usage"), dict):
                usage = _merge_usage(usage, evt["usage"])
            choices = evt.get("choices")
            if isinstance(choices, list) and choices:
                c0 = choices[0] if isinstance(choices[0], dict) else {}
                if c0.get("finish_reason"):
                    finish = c0["finish_reason"]
                delta = c0.get("delta") or {}
                if isinstance(delta, dict):
                    if delta.get("tool_calls"):
                        tool_calls = max(tool_calls, len(delta["tool_calls"]))
                        for tc in delta["tool_calls"]:
                            fn = (tc or {}).get("function") or {}
                            if fn.get("name"):
                                tool_names.append(str(fn["name"]))
                    if delta.get("content"):
                        text_bytes += len(delta["content"])
    else:
        try:
            obj = json.loads(raw)
        except Exception:
            return res
        if not isinstance(obj, dict):
            return res
        if obj.get("error"):
            err = json.dumps(obj["error"])[:400]
        usage = _merge_usage(None, obj.get("usage"))
        out = obj.get("output")
        if isinstance(out, list):
            tool_calls += sum(1 for o in out if isinstance(o, dict) and o.get("type") == "function_call")
            for o in out:
                if isinstance(o, dict) and o.get("type") == "function_call" and o.get("name"):
                    tool_names.append(str(o["name"]))
        # Anthropic Messages (non-streaming): a flat content-block array plus a
        # top-level stop_reason.
        blocks = obj.get("content")
        if isinstance(blocks, list):
            for block in blocks:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    tool_calls += 1
                    if block.get("name"):
                        tool_names.append(str(block["name"]))
                elif block.get("type") == "text":
                    text_bytes += len(block.get("text") or "")
                elif block.get("type") == "thinking":
                    thinking_bytes += len(block.get("thinking") or "")
        if obj.get("stop_reason"):
            finish = obj["stop_reason"]
        choices = obj.get("choices")
        if isinstance(choices, list) and choices:
            c0 = choices[0] if isinstance(choices[0], dict) else {}
            finish = c0.get("finish_reason")
            msg = c0.get("message") or {}
            if isinstance(msg, dict):
                if msg.get("tool_calls"):
                    tool_calls += len(msg["tool_calls"])
                    for tc in msg["tool_calls"]:
                        fn = (tc or {}).get("function") or {}
                        if fn.get("name"):
                            tool_names.append(str(fn["name"]))
                if msg.get("content"):
                    text_bytes += len(msg["content"])
        if obj.get("status"):
            finish = finish or obj["status"]

    if tool_calls:
        res["tool_calls"] = tool_calls
    if tool_names:
        res["tool_names"] = tool_names[:40]
    if finish:
        res["finish"] = finish
    if text_bytes:
        res["text_bytes"] = text_bytes
    if thinking_bytes:
        res["thinking_bytes"] = thinking_bytes
    if err:
        res["upstream_error"] = err
    if isinstance(usage, dict):
        res["usage"] = _usage_out(usage)
    return res


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "mica-bench-proxy"

    def log_message(self, fmt, *args):
        pass

    def _health(self):
        body = json.dumps({
            "ok": True,
            "upstream": UPSTREAM,
            "routes": _load_routes(),
            "counters": dict(_stats),
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle(self, method):
        started = time.time()
        raw_path = self.path
        path, _, query = raw_path.partition("?")
        if path.startswith(PREFIX) is False and path.startswith("/__"):
            return self._health()

        agent, task, rest = split_route(path)
        up_host, up_port, up_tls, up_base = resolve_upstream(agent)
        upstream_path = (up_base + rest) if rest.startswith("/") else "/" + up_base + rest
        if query:
            upstream_path += "?" + query

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""

        seq = next_seq(agent, task)
        rec = {
            "ts": started,
            "agent": agent,
            "task": task,
            "seq": seq,
            "method": method,
            "upstream_path": upstream_path,
        }
        try:
            rec.update(describe_request(body, self.headers.get("Content-Type", "")))
        except Exception as exc:
            rec["describe_error"] = str(exc)

        if SAVE_BODIES:
            d = os.path.join(RAW_DIR, str(agent))
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, f"{seq:04d}-{int(started*1000)}.json"), "wb") as fh:
                fh.write(body)

        headers = {}
        for k, v in self.headers.items():
            if k.lower() in ("host", "content-length", "accept-encoding", "connection"):
                continue
            headers[k] = v
        headers["Content-Length"] = str(len(body))
        headers["Accept-Encoding"] = "identity"

        status = None
        ctype = ""
        ttfb_ms = None
        try:
            # Resolved per request, not per process: the console can repoint an
            # agent's upstream without restarting (and without dropping
            # in-flight requests).
            conn = http.client.HTTPSConnection(up_host, up_port, timeout=3600) if up_tls \
                else http.client.HTTPConnection(up_host, up_port, timeout=3600)
            conn.request(method, upstream_path, body=body or None, headers=headers)
            resp = conn.getresponse()
            status = resp.status
            ctype = resp.getheader("Content-Type", "") or ""

            self.send_response(status)
            for k, v in resp.getheaders():
                if k.lower() in ("transfer-encoding", "content-length", "connection", "content-encoding"):
                    continue
                self.send_header(k, v)
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()

            chunks = []
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                if ttfb_ms is None:
                    ttfb_ms = round((time.time() - started) * 1000)
                chunks.append(chunk)
                self.wfile.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
            conn.close()
            raw = b"".join(chunks)
        except Exception as exc:
            rec["proxy_error"] = f"{type(exc).__name__}: {exc}"
            _stats["proxy_errors"] += 1
            try:
                msg = json.dumps({"error": {"message": rec["proxy_error"]}}).encode()
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
            except Exception:
                pass
            rec["duration_ms"] = round((time.time() - started) * 1000)
            rec["status"] = status
            log_record(rec)
            return

        rec["status"] = status
        rec["resp_bytes"] = len(raw)
        rec["duration_ms"] = round((time.time() - started) * 1000)
        if ttfb_ms is not None:
            rec["ttfb_ms"] = ttfb_ms
        try:
            rec.update(describe_response(raw, ctype, ttfb_ms))
        except Exception as exc:
            rec["describe_resp_error"] = str(exc)
        if status and status >= 400:
            rec["error_body"] = raw[:600].decode("utf-8", "replace")
            _stats["http_errors"] += 1
        _stats["requests"] += 1
        log_record(rec)

    def do_POST(self):
        self._handle("POST")

    def do_GET(self):
        self._handle("GET")


def main():
    os.makedirs(os.path.dirname(os.path.abspath(LOG_PATH)), exist_ok=True)
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    print(f"[proxy] listening 0.0.0.0:{PORT} -> {UPSTREAM}", flush=True)
    print(f"[proxy] route  /agent_bench/<agent>/task=<task>/<path>", flush=True)
    print(f"[proxy] log    {LOG_PATH}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
