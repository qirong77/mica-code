"""Preflight: verify the recording proxy authenticates, routes per agent, and
records usage for both protocol families.  Costs a few tokens; never prints the key."""
from __future__ import annotations

import json
import pathlib
import urllib.error
import urllib.request

APP = pathlib.Path(__file__).resolve().parent.parent
KEY = json.loads((APP / "console" / "settings.json").read_text())["api_key"]
BASE = "http://127.0.0.1:8899"
MODEL = "deepseek-flash"


def post(path: str, body: dict) -> tuple[int, dict | str]:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {KEY}",
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:400]
    except Exception as e:  # noqa: BLE001
        return 0, f"{type(e).__name__}: {e}"


print("=== OpenAI-family path (mica) ===")
st, out = post(
    "/agent_bench/mica/task=_preflight/v1/chat/completions",
    {"model": MODEL, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 1},
)
print("status:", st)
if isinstance(out, dict):
    print("id:", out.get("id"))
    print("usage:", out.get("usage"))
    print("choices:", len(out.get("choices") or []))
else:
    print("body:", out)

print()
print("=== Anthropic-family path (claude-code) ===")
st, out = post(
    "/agent_bench/claude-code/task=_preflight/v1/messages",
    {
        "model": MODEL,
        # The real client always sends a top-level `system`; that is also what
        # makes the proxy label the row `anthropic_messages`.
        "system": "You are a helpful assistant.",
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
    },
)
print("status:", st)
if isinstance(out, dict):
    print("id:", out.get("id"))
    print("usage:", out.get("usage"))
    print("type:", out.get("type"))
else:
    print("body:", out)
