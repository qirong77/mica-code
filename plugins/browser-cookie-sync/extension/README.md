# Mica Cookie Sync Chrome extension

In Mica's Browser Cookie Sync plugin settings, click **安装 Chrome 扩展** to materialize this directory and obtain the local token. Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose the directory shown by Mica. Open the extension's **Options** page and paste the token. Mica must be running with its local service at `127.0.0.1:19387`.

The extension sends Chrome cookie changes with `POST /events` and reads Mica changes from `GET /events` (SSE). Both requests and the startup `GET /snapshot` carry `Authorization: Bearer <token>`. The token stays in `chrome.storage.local` and is never injected into websites. The extension requests cookie access to all sites so it can observe and update their cookies; only install it from a source you trust.

When connecting or reconnecting, the extension compares both sides with its last synced fingerprints. With no prior fingerprint, a cookie that exists only on one side is copied to the other. If both sides have different values with no history, neither side is overwritten. If both changed while offline, neither side is overwritten; otherwise the side that changed wins. Partitioned (CHIPS) cookies are deliberately not synchronized.

Requires Chrome 110 or newer. Each 20-second SSE heartbeat makes a cheap storage API call to reset the worker's idle timer; it does not read browser cookies. A one-minute alarm retries after suspension or while Mica was offline; only reconnection reads a full snapshot to repair missed changes. This is not an always-on connection guarantee. Only the default Chrome cookie store is supported.
