#!/usr/bin/env python3
import json, os, urllib.request, ssl

auth = json.load(open(os.path.expanduser("~/.codex/auth.json")))
tok = auth["tokens"]["access_token"]
acct = auth["tokens"].get("account_id") or ""

op = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": "http://127.0.0.1:7897",
                                 "https": "http://127.0.0.1:7897"}),
    urllib.request.HTTPSHandler(context=ssl.create_default_context()),
)
r = urllib.request.Request(
    "https://chatgpt.com/backend-api/wham/usage",
    headers={"Authorization": "Bearer " + tok, "chatgpt-account-id": acct,
             "originator": "codex_cli_rs", "User-Agent": "codex_cli_rs/0.162.1"},
)
try:
    with op.open(r, timeout=30) as resp:
        d = json.loads(resp.read().decode())
    rl = d.get("rate_limit") or {}
    out = {"plan_type": d.get("plan_type"), "rate_limit": rl}
    print(json.dumps(out, ensure_ascii=False, indent=2)[:3000])
except Exception as e:
    print("ERR", type(e).__name__, str(e)[:300])
