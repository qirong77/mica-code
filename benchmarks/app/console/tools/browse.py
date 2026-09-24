#!/usr/bin/env python3
"""Thin helper around the remote-browser service for iterating on the console.

The service returns inline base64 for screenshots and wraps every reply in
{ok, data|error}, so both need unwrapping.  Sub-commands:

  open <url>                 -> print the new tabId
  eval <tabId> <expr>        -> print the JS result as JSON
  scroll <tabId> <deltaY>    -> scroll the window
  shot <tabId> <out.png> [full]
"""
import base64
import json
import sys
import urllib.request

BASE = "http://127.0.0.1:18766/browser"


def call(path: str, payload: dict, timeout: int = 60):
    req = urllib.request.Request(
        f"{BASE}/{path}",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    cmd, args = sys.argv[1], sys.argv[2:]

    if cmd == "open":
        out = call("open", {"url": args[0], "clientId": "mica-bench", "focus": True})
        if not out.get("ok"):
            print("FAILED:", json.dumps(out.get("error"))[:400])
            return 1
        target = (out.get("meta") or {}).get("target") or {}
        print(target.get("tabId"))
        return 0

    if cmd == "eval":
        out = call("evaluate", {"tabId": args[0], "expression": args[1]})
        if not out.get("ok"):
            print("FAILED:", json.dumps(out.get("error"))[:400])
            return 1
        print(json.dumps(out["data"], ensure_ascii=False))
        return 0

    if cmd == "scroll":
        out = call("scroll", {"tabId": args[0], "deltaY": int(args[1])})
        print("ok" if out.get("ok") else json.dumps(out.get("error"))[:300])
        return 0 if out.get("ok") else 1

    if cmd == "shot":
        out = call("screenshot", {"tabId": args[0], "fullPage": len(args) > 2})
        if not out.get("ok"):
            print("FAILED:", json.dumps(out.get("error"))[:400])
            return 1
        data = out["data"]
        with open(args[1], "wb") as handle:
            handle.write(base64.b64decode(data["base64"]))
        print(f"saved {args[1]} ({data['width']}x{data['height']})")
        return 0

    print("unknown command:", cmd)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
