#!/usr/bin/env python3
"""Capture a screenshot of the console via the remote-browser service and save
it as a PNG.  The service answers inline base64, so decoding is on us.

Usage: shot.py <tabId> <out.png> [fullPage]
"""
import base64
import json
import sys
import urllib.request

SERVICE = "http://127.0.0.1:18766/browser/screenshot"


def main() -> int:
    tab_id, out = sys.argv[1], sys.argv[2]
    full = (len(sys.argv) > 3 and sys.argv[3] != "0")
    body = json.dumps({"tabId": tab_id, "fullPage": full}).encode()
    req = urllib.request.Request(
        SERVICE, data=body, headers={"content-type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.load(resp)
    if not payload.get("ok"):
        print("FAILED:", json.dumps(payload.get("error"))[:300])
        return 1
    data = payload["data"]
    with open(out, "wb") as handle:
        handle.write(base64.b64decode(data["base64"]))
    print(f"saved {out} ({data['width']}x{data['height']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
