# mica-code-app

The app is a **web page**: `src/server` runs it as a dependency-free Node HTTP + SSE runtime, so any
browser (including phones on the same LAN) gets the full workspace — session management, file
editing, workspace search, Git diff views and the chat view. Electron is an optional container
around that same page: it starts the runtime, points a window at it, and adds native touches
(dock badge, taskbar attention, external links) that the browser simply does without.

The Chat tab replaces the old terminal-hosted Mica view: every chat node keeps one resident `mica app-server` child process (Codex v2 App Server protocol over stdio) and renders reasoning / text / tool calls / finish states as a terminal-style web conversation. Sessions are shared with the Mica CLI (`~/.mica/sessions`), so conversations started in the terminal or the app can be resumed in either place. The Git status bar opens a VS Code-style branch picker for searching and switching local branches and creating branches from the current or a selected ref.

## Tech stack

- Dependency-free Node HTTP + SSE runtime (`src/server`) hosting the renderer
- Electron + electron-vite for the optional desktop container
- React 19 + React DOM
- Vite + `@vitejs/plugin-react`
- Tailwind CSS v4 + `@tailwindcss/vite`
- xterm.js for the terminal tab
- Monaco Editor for file editing and Git comparisons
- lucide-react for product icons

## Chat protocol

The Chat tab talks to the Mica CLI via `mica app-server`, a per-chat-node resident process speaking the Codex v2 App Server protocol subset over stdio (JSON-RPC style, one JSON object per line): the app sends `initialize`/`thread/start`/`turn/start`/`turn/steer`/`turn/interrupt` and consumes v2 notifications (`turn/started`, `turn/completed`, `item/agentMessage/delta` for text, `item/reasoning/textDelta` for thinking, `item/commandExecution/outputDelta` plus `item/started`/`item/completed` for tool calls — pending then completed with the same item id, `thread/tokenUsage/updated` for usage). Mica extension notifications surface long-lived host state: `mica/queue/*` for the after_iteration queue and `mica/backgroundTasks/updated`/`mica/subagentTasks/updated` snapshots for background shell tasks and running subagents (including background subagents still active after the parent turn), which the renderer keeps as resident rows above the composer — the same task status area the CLI shows above its input. The runtime (`src/host/chat.js`) maps these notifications back to the renderer's internal event shape (forwarding each `thread/tokenUsage/updated` as it arrives, so the composer status line's tokens/cached/ctx keep refreshing during long turns instead of only at `turn/completed`; those figures come from `tokenUsage.last`, the current context occupancy), paces adjacent text/reasoning deltas, and keeps the host alive across turns (skipping process startup, session reload and MCP re-init; Shift+Tab steers into the active turn for after_iteration injection, plain Tab queues locally for after_turn). Aborts send `turn/interrupt` instead of killing the process (SIGTERM fallback). Conversation history plus model/context metadata is read from `~/.mica/sessions/*.json` when a session is reopened, and turn lifecycle notifications are posted to the local notify server so sidebar dots and unread badges behave exactly like PTY-hosted Mica sessions.

The sidebar intentionally has only two activity indicators: the row title breathes green (`chat-running-text`) while a Mica turn or terminal process is running, and a blue dot marks a result the user has not read yet. Merely opening an idle session never creates a status dot; running takes precedence if both flags are present (the title animates and no dot is shown). Recent rows lead with the working directory base name in muted text, so sessions from different projects stay distinguishable. Closing a conversation is no longer a hover affordance on the left — the row's more-actions menu and the right-click context menu own it. The Inbox section only lists finished work that is still unread — a running turn stays out of it until it produces a result to review.

Chat Markdown uses `react-markdown` with GFM support. Raw HTML is not rendered; tables, task lists, fenced code, nested lists and streaming incomplete blocks are handled by the parser, while code blocks, messages and tool details expose copy actions. `TodoWrite` drives a plan dock above the composer, and Agent/background-shell calls receive dedicated activity summaries.

The Chat view keeps the same minimal status line as the Mica terminal: the left side shows the running indicator, and the right side shows `model_effort` and context usage as plain text. A single-line bar above the transcript always shows the newest sent user message (`lastUserPromptText`, ellipsised; queued messages stay in the queue dock instead), so the current task stays visible while scrolling. Clicking the model text opens a selection panel (catalog from `mica models`), clicking the `ctx` text opens a context-usage modal with a token bar and the same breakdown as `/context`; both apply on the next message via `--model`/`--variant`/`--role` headless overrides that persist into the session snapshot. The app footer pairs the Git branch (left) with the working directory (right), and both always describe the same directory: the active chat node's working directory, never the `cd` of a shell running in the terminal tab. Clicking the directory opens a picker (recent directories aggregated from session history, a system folder chooser, and manual input); switching re-points the current chat and becomes the default directory, so New Session starts in the most recently used directory. Typing `/` opens a Web command palette for the remaining Chat commands (`/help`, `/status`, `/rename`, `/resume`, `/todo`, `/config`, `/compact`, plus explicit `/model` `/effort` `/role` values); `/compact` runs the headless `mica compact --session <id>` (same `CompactionService` as the terminal, with a busy guard and a before/after token summary) and refreshes the conversation. Remaining selector-heavy Ink commands like `/rewind` are never sent to the model and instead offer a copy-and-open-Terminal handoff. Auto-scroll follows output only while the reader remains near the bottom, with resize anchoring for streaming Markdown and reasoning.
Pasting an image into the composer saves it into `~/.mica/images/` (mirroring the terminal input) and inserts an `[Image](...)` ref; the headless run resolves the ref into a multimodal content block before calling the model, so vision-capable models see the pasted image directly. Models whose API rejects image input (e.g. DeepSeek chat completions) surface the provider error in the conversation instead.

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev            # builds the runtime, then electron-vite dev (renderer HMR)
```

In dev the page is served by the Vite dev server and `electron.vite.config.mjs` proxies `/api` to
the runtime, so the page always talks to `/api` on its own origin.

### Production build

```bash
$ npm run build          # = build:app (shell + renderer) + build:server (runtime)
```

### Package

```bash
# Windows
$ npm run build:win

# macOS
$ npm run build:mac

# Linux
$ npm run build:linux
```

## Architecture: web runtime + Electron container

- `src/host/` — the business core (terminals, chat, files, Git, stats, workspace, settings, notify
  server). It runs inside the runtime process only.
- `src/server/` — the runtime. A dependency-free Node HTTP + SSE server that hosts the renderer
  bundle and exposes `src/host` over `/api`. `vite.server.config.mjs` aliases `electron` to
  `src/server/electron-shim.js`, which implements the exact surface those modules use
  (`ipcMain.handle`, a shared `event.sender`, `app.getPath`, `shell`, `clipboard`, `dialog`).
- `src/main/index.js` — the Electron container. It spawns the runtime
  (`ELECTRON_RUN_AS_NODE`), loads the window at the runtime URL, mirrors unread notifications onto
  the dock badge (and flashes the taskbar on Windows), and stops the runtime on quit. It registers
  no business IPC and injects no preload: the page always builds `window.mica` from HTTP + SSE, so
  the window and a phone browser run byte-identical UI code.
- `ELECTRON_RUN_AS_NODE` is a bootstrap marker for the runtime process only. The runtime calls
  `stripContainerEnv()` before it derives any child environment, so PTY terminals, `mica` children
  and the shell-env capture never inherit it — otherwise running `electron` from a terminal inside
  the app (e.g. `electron-vite dev`) starts as plain Node and crashes on `electron.app`.
- `src/renderer/` — the page itself.

### Running the runtime on its own (browser / LAN)

```bash
$ npm run build          # build everything (or npm run build:server alone)
$ npm run start:web      # node out/server/index.mjs
$ npm run serve:web      # = build && start:web

# options
$ node out/server/index.mjs --host 0.0.0.0 --port 8787 --renderer out/renderer [--allow-missing-renderer]
```

Environment variables with the same meaning: `MICA_DESKTOP_HOST`, `MICA_DESKTOP_PORT`,
`MICA_DESKTOP_RENDERER`. The runtime prints both the loopback and LAN URLs on startup, plus a
machine-readable `[mica-desktop] ready {"url":…,"port":…}` line the Electron container parses.
If the port is taken it falls back to a free one; `GET /api/health` answers whether a port is
already serving Mica Code.

### How it is wired

- `POST /api/invoke` `{ channel, payload }` is the `ipcRenderer.invoke` equivalent; handlers run in
  the same process as the Electron main process would, so PTY terminals, resident `mica app-server`
  hosts, file/Git/stats/config access all behave identically.
- `GET /api/events` is a Server-Sent Events stream carrying every push channel
  (`terminal:data|exit`, `chat:event|exit|queue-state|queue-error|commit-exit`, `notify:changed`).
  Events are broadcast to every connected client, so a phone and a desktop tab share one state.
- `GET /api/env` returns `platform` / `homeDir` / `runShellLogConfig`; the renderer fetches it
  before mounting and installs `window.mica` (see `src/renderer/src/transport.js`).
- `GET /api/image?path=...` serves pasted and attached images, replacing the `file://` URLs that
  only resolve inside Electron.
- `MICA_DESKTOP_USER_DATA` (the container passes `app.getPath('userData')`) and the shim default
  resolve to the same `mica-code-app` directory, so `workspace.json`, `file-order.json` and
  `session-pins.json` are shared between the desktop app and a standalone runtime.

### What the page does differently from a native app

- **Folder pickers become in-app.** `dialog:select-directory` has no browser equivalent, so
  `CwdModal` opens `DirectoryPicker`, which browses the _server's_ filesystem through `files:list`.
- **Clipboard writes happen in the browser.** `files.copyPath` / `copyRelativePath` copy locally via
  `navigator.clipboard` with an `execCommand` fallback (a plain-HTTP LAN page is not a secure
  context). `files.reveal` still opens the containing folder on the server machine.
- **External links open in the browser tab**, not on the server.
- **Terminal file links open the in-app editor** instead of VS Code: the transport dispatches a
  `mica:open-file` event that `App.jsx` routes to the Files panel.
- **The Settings iframe points at the server.** `settings:open` returns a `127.0.0.1` URL that the
  transport rewrites to `location.hostname`; the server starts the config-web worker with
  `MICA_CONFIG_WEB_HOST=0.0.0.0` so other devices can embed it, and widens the `frame-src` CSP
  directive in the served HTML.
- **Window focus/visibility comes from the page**: `document.visibilityState` plus `focus`/`blur`.

### Mobile layout

Below 768px the three-column shell collapses to a single column: the session list and the right
panel become overlay drawers (scrim + close button), the Files panel swaps between the tree and the
editor behind a back button, and right-click-only actions gain long-press equivalents on touch
(`longPressHandlers` ignores mouse pointers, so desktop behaviour is unchanged). `?layout=mobile`
and `?layout=desktop` force a layout for previewing on a large screen.

> There is no authentication: anyone who can reach the port gets a shell on the host. The runtime
> binds `0.0.0.0` by default (so phones can join); pass `--host 127.0.0.1` when you don't want that.

### App icon

`resources/icon.svg` is the app mark (soft rounded square with a hand-drawn `M` built from four uneven strokes, slightly tilted); `build/icon.svg` is a byte-identical copy used as the electron-builder build resource. `src/main/index.js` imports `resources/icon.png` for the window/taskbar icon, and `electron-builder.yml` packages `build/icon.icns` (macOS), `build/icon.ico` (Windows) and `build/icon.png` (Linux).

Two geometry rules keep the icon out of the macOS 26 Tahoe gray "icon jail" (a gray squircle plate the system draws behind legacy icons):

- **Corner radius must stay at or below `19/64` of the icon size.** This is the actual trigger — not the margin. Verified on macOS 26.0 through `NSWorkspace.icon(forFile:)`: `rx=19/64` renders normally, `rx=20/64` and above get jailed, at any margin. The SVG uses Apple's 22.375% (`rx=14.32/64`) for headroom.
- **The mark stays inside Apple's 824/1024 content area** (6.25/64 transparent margin per side) so the icon keeps the classic Big Sur–Sequoia grid on macOS ≤ 15. Tahoe scales the artwork up to fill the tile either way, so the margin costs nothing there.

Editing the SVG must keep both properties, otherwise the Dock icon regresses to the jailed look.

Regenerate every raster asset after editing the SVG (macOS only; needs `sips`/`iconutil` and Pillow):

```bash
$ npm run icons:generate
```

The script renders the SVG at 4x and downscales with LANCZOS, so the gradient stays clean at 1024px without dithering noise.
