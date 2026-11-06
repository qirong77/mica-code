# Mica Cookie Sync Chrome extension

In Mica's Browser Cookie Sync plugin settings, click **安装 Chrome 扩展** to materialize this directory and obtain the local token. Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose the directory shown by Mica. Set the extension's site access to **On all sites** so Chrome grants cookie access. Then click the toolbar icon: the popup shows connection state, takes the token, and offers **立即同步** (sync now) and **重新连接** (reconnect). The token can also be entered on the **Options** page. Mica must be running with its local service at `127.0.0.1:19387`.

**立即同步** runs one full comparison immediately instead of waiting for the one-minute reconnect alarm, and reports how many cookies were compared, written to Chrome, written to Mica, skipped as conflicts, or failed. A single failed write no longer aborts the whole round.

The popup only calls `GET /health` with the stored token, so it can tell apart a missing token, a wrong token, a stopped service and a service that is running while the event stream is not connected. It never reads browser cookies; the sync itself runs in the service worker.

## Self-update

`version.json` carries this build's `version` and a content `fingerprint` (both written by `scripts/generate-browser-cookie-extension-sources.mjs`). Mica refreshes `extension-v2/` whenever its embedded copy changes and reports the same fingerprint plus the last write time over `GET /health`. Every reconnect alarm the service worker compares the two: on a mismatch it calls `chrome.runtime.reload()` so the new code loads without the user reloading the extension by hand. Repeated mismatches for the same fingerprint back off exponentially, up to once a day; a service that reports no `extension` field is ignored.

The popup shows `扩展 v<version> · 上次更新 <time>`, switches that line to "on disk is vX" plus a **立即重载** button when the fingerprints differ.

`icons/` is rendered from `apps/desktop/resources/icon.svg` (the single brand asset) with the same 22.375% corner radius; regenerate rather than hand-edit. `scripts/generate-browser-cookie-extension-sources.mjs` embeds the PNGs as base64 in `extensionSources.ts` because they cannot live in the JSON string map.

The extension sends Chrome cookie changes with `POST /events` and reads Mica changes from `GET /events` (SSE). Both requests and the startup `GET /snapshot` carry `Authorization: Bearer <token>`. The token stays in `chrome.storage.local` and is never injected into websites. The extension requests cookie access to all sites so it can observe and update their cookies; only install it from a source you trust.

When connecting or reconnecting, the extension compares both sides with its last synced fingerprints. With no prior fingerprint, a cookie that exists only on one side is copied to the other. If both sides have different values with no history, neither side is overwritten. If both changed while offline, neither side is overwritten; otherwise the side that changed wins. Partitioned (CHIPS) cookies are deliberately not synchronized.

Requires Chrome 110 or newer. Each 20-second SSE heartbeat makes a cheap storage API call to reset the worker's idle timer; it does not read browser cookies. A one-minute alarm retries after suspension or while Mica was offline; only reconnection reads a full snapshot to repair missed changes. This is not an always-on connection guarantee. Only the default Chrome cookie store is supported.
