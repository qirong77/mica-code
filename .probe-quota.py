#!/usr/bin/env python3
import json, urllib.request, http.cookiejar, os

cfg = json.load(open(os.path.expanduser("~/.mica/omniroute.json")))
base = cfg["base_url"].rstrip("/")
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(base + path, data=data,
                               headers={"Content-Type": "application/json"},
                               method=method)
    try:
        with op.open(r, timeout=25) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


print("login:", req("POST", "/api/auth/login", {"password": cfg["password"]})[0])

for path in ["/api/usage/provider-limits", "/api/usage/quota"]:
    st, body = req("GET", path)
    print("\n===", path, st, "===")
    print(json.dumps(body, ensure_ascii=False, indent=2)[:4000])
