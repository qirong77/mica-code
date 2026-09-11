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

The sidebar intentionally has three activity indicators sharing one fixed row-leading slot (`RowLeading`, always `w-4` so every row keeps the same title indent): a green dot breathing while a Mica turn is running (`chat-dot-running`), the terminal icon while that session has a long-running terminal foreground process, and a blue dot marking a result the user has not read yet. The terminal icon owns the slot when both apply, with the unread dot stacked on its top-right corner; running takes precedence over unread, and merely opening an idle session never creates a status dot. Recent rows lead with the working directory base name in muted text, so sessions from different projects stay distinguishable. Closing a conversation is no longer a hover affordance on the left — the row's more-actions menu and the right-click context menu own it.

The Files tab's activity bar mirrors VS Code with four entries: Explorer, Search, Source Control (`CHANGES`) and a `GIT TREE` panel that roots the same change tree at the current branch. While the workspace is dirty the source-control icon carries an orange badge with the changed-file count, and the explorer decorates changes the way VS Code does — a changed file takes its status colour (gold modified, green added, red deleted) plus a trailing `M`/`A`/`D` letter, and every folder above it inherits the most significant status of its subtree and shows a dot. Status letters, colours, the folder roll-up and the repository-relative path helper live in `src/renderer/src/git-decorations.js`. The explorer header follows the VS Code layout too: the folder's base name in bold (the absolute path only survives as the tooltip) plus four buttons — new file, new folder, collapse all — the latter dropping loaded subtrees so expanding re-reads them — and a more-actions menu holding refresh, collapse all, go to the parent directory, reveal in file manager and copy path. Menus share one floating layer (`FloatingMenu`) whose anchor buttons opt out of the press-to-close rule, which is what lets the more-actions button toggle its own menu.

Chat Markdown uses `react-markdown` with GFM support. Raw HTML is not rendered; tables, task lists, fenced code, nested lists and streaming incomplete blocks are handled by the parser, while code blocks, messages and tool details expose copy actions. `TodoWrite` drives a plan dock above the composer, and Agent/background-shell calls receive dedicated activity summaries.

The Chat view keeps the same minimal status line as the Mica terminal: the left side shows the running indicator, and the right side shows `model_effort` and context usage as plain text. A single-line bar above the transcript always shows the newest sent user message (`lastUserPromptText`, ellipsised; queued messages stay in the queue dock instead), so the current task stays visible while scrolling. Clicking the model text opens a selection panel (catalog from `mica models`), clicking the `ctx` text opens a context-usage modal with a token bar and the same breakdown as `/context`; both apply on the next message via `--model`/`--variant`/`--role` headless overrides that persist into the session snapshot. The app footer pairs the Git branch (left) with the working directory (right), and both always describe the same directory: the active chat node's working directory, never the `cd` of a shell running in the terminal tab. Clicking the directory opens a picker (recent directories aggregated from session history, a system folder chooser, and manual input); switching re-points the current chat and becomes the default directory, so New Session starts in the most recently used directory. Typing `/` opens a Web command palette for the remaining Chat commands (`/help`, `/status`, `/rename`, `/resume`, `/todo`, `/config`, `/compact`, plus explicit `/model` `/effort` `/role` values); `/compact` runs the headless `mica compact --session <id>` (same `CompactionService` as the terminal, with a busy guard and a before/after token summary) and refreshes the conversation. Remaining selector-heavy Ink commands like `/rewind` are never sent to the model and instead offer a copy-and-open-Terminal handoff. Auto-scroll follows output only while the reader remains near the bottom, with resize anchoring for streaming Markdown and reasoning.
Pasting an image into the composer saves it into `~/.mica/images/` (mirroring the terminal input) and inserts an `[Image](...)` ref; the headless run resolves the ref into a multimodal content block before calling the model, so vision-capable models see the pasted image directly. Models whose API rejects image input (e.g. DeepSeek chat completions) surface the provider error in the conversation instead. The photo button next to send covers the same path for devices without a clipboard paste (phones): it opens a file picker limited to the formats the CLI can read (`accept="image/png,image/jpeg,image/webp,image/gif"`, which is also what makes iOS transcode HEIC to JPEG), uploads every selected file through `POST /api/paste-image`, and inserts the refs at the caret. `saveImageDataUrl` (`src/host/chat-images.js`) names the stored file after the data URL's media type — falling back to magic-byte sniffing — instead of always writing `.png`, which is what previously mislabelled a pasted JPEG.

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

The mobile block in `assets/app.css` also floors every form control at `16px`. iOS Safari zooms the
whole page when a control with a smaller computed font size takes focus, and it does not zoom back
out on blur — the page stays magnified after leaving the composer. The rule is scoped as
`#root input, #root select, #root textarea:not(.inputarea)` so it outranks Tailwind's per-component
`text-[13px]` utilities, and it exempts monaco's hidden `inputarea` textarea (the editor measures
and positions IME candidates off that element). The composer action buttons grow to 32px at the same
breakpoint because 25px is below a comfortable touch target.

The terminal tab gets a `TerminalKeyBar` below 768px, under the terminal: a soft keyboard has no
Esc, Tab, Ctrl or arrow keys, which leaves shell completion, interrupt and history unreachable —
the desktop modifier mapping in `TerminalHost.jsx` only sees physical keyboards. The bar sends the
same raw sequences through `TerminalHost`'s `input()` → `term.input()`, so they take xterm's own
input path (`term.input` → `onData`) rather than writing to the PTY directly (`terminal-keys.js`
holds the table and the clipboard read). Its buttons cancel `pointerdown` so tapping a key never
pulls focus out of xterm's hidden textarea: losing focus dismisses the keyboard, which would take
the bar down with it.
The paste button reads `navigator.clipboard`, which is unavailable over plain http in a LAN (not a
secure context), so an unreadable clipboard shows a hint pointing at the system keyboard's own
paste instead of failing silently.

Plain typing needed a fix too, and not one of ours: xterm 6's `_inputEvent` only accepts an `input`
event satisfying `!e.composed || !_keyDownSeen`. Browsers dispatch `input` with `composed === true`
and `_keyDownSeen` is true between `keydown` and `keyup`, so **any `input` that follows a `keydown`
is dropped**. Space and A–Z only ever travel that path — xterm sends nothing for them from `keydown`
(it defers to the `keypress` that desktop browsers fire and mobile ones do not) — so they vanished,
leaving stray characters in the hidden textarea. `attachCustomKeyEventHandler` now re-sends those
two classes of key on `(pointer: coarse)` via `softKeyboardFallbackKey` (`terminal-keys.js`),
calling `preventDefault()` itself (otherwise the browser still writes the character into the
textarea and a desktop `keypress` would send it a second time) and letting `keyCode` 229/0 through
to xterm's own Android composition handling. Upstream fixed this in PR #5614 (`!isComposing &&
!isSendingComposition`), which is not in 6.0.0 — drop the re-send and re-verify when xterm is
upgraded. Input with no `keydown` at all (CJK IME punctuation, dictation) still drops.

The terminal is already rendered as HTML: xterm 6's core renderer is the DOM one, so rows are
`<span>`s inside `.xterm-rows` and the only real `<canvas>` on screen is the overview ruler. That is
also why its font size cannot come from CSS — the DOM renderer writes an inline `font-size` on
`.xterm-rows` derived from the `fontSize` option, so any rule on `.terminal-pane .xterm` is dead.
Change the option instead. None of this makes the terminal behave like an `<input>`: it is a
character grid painted from whatever the PTY emitted, so there is no native caret to tap into and no
text selection to drag — the arrow keys on the key bar are how the cursor moves.

Keyboard avoidance is shared by every bottom-anchored element: when the keyboard opens, iOS Safari
and Android Chrome shrink only the visual viewport, not the layout viewport, and `dvh` follows the
URL bar rather than the keyboard. `useVisualViewportHeight` (`hooks.js`) writes the visible height
into `--vvh`, and the narrow-screen root height is `var(--vvh, 100dvh)`, so the composer and the
terminal key bar rise above the keyboard instead of being covered by it.

> There is no authentication: anyone who can reach the port gets a shell on the host. The runtime
> binds `0.0.0.0` by default (so phones can join); pass `--host 127.0.0.1` when you don't want that.

### App icon

`resources/icon.svg` is the app mark (soft rounded square with a hand-drawn `M` built from four uneven strokes, slightly tilted) — and the repo's **only** brand mark: the website (`apps/website`), the config web UI (`apps/config-web`) and the README all reference this same file, so editing it here updates every surface. It is drawn full-bleed (the tile fills the viewBox) because web icons have to fill their box; the macOS content margin described below is applied when rasterizing, not baked into the SVG.

`src/main/index.js` imports `resources/icon.png` for the window/taskbar icon, and `electron-builder.yml` packages `build/icon.icns` (macOS), `build/icon.ico` (Windows) and `build/icon.png` (Linux). `npm run icons:generate` (macOS + Pillow) rasterizes those plus the desktop web/PWA icons in `src/renderer/public`, widening the viewBox for the native sizes and rendering the web sizes full-bleed.

Two geometry rules keep the icon out of the macOS 26 Tahoe gray "icon jail" (a gray squircle plate the system draws behind legacy icons):

- **Corner radius must stay at or below `19/64` of the icon size.** This is the actual trigger — not the margin. Verified on macOS 26.0 through `NSWorkspace.icon(forFile:)`: `rx=19/64` renders normally, `rx=20/64` and above get jailed, at any margin. The SVG uses Apple's 22.375% (`rx=14.32/64`) for headroom.
- **The native rasterizations keep the mark inside Apple's 824/1024 content area** — `scripts/generate-icons.py` widens the viewBox by `1/0.8046875` (the same 6.25/64 transparent margin per side) so the icon keeps the classic Big Sur–Sequoia grid on macOS ≤ 15. Tahoe scales the artwork up to fill the tile either way, so the margin costs nothing there. Web/PWA icons are deliberately rendered without it (an inset favicon looks shrunken next to every other tab, and iOS applies its own 22.375% mask on "Add to Home Screen").

Editing the SVG must keep both properties, otherwise the Dock icon regresses to the jailed look.

Regenerate every raster asset after editing the SVG (macOS only; needs `sips`/`iconutil` and Pillow):

```bash
$ npm run icons:generate
```

The script renders the SVG at 4x and downscales with LANCZOS, so the gradient stays clean at 1024px without dithering noise.

The same run writes the **web icons** into `src/renderer/public/`, which Vite copies verbatim into
the renderer output (so the runtime serves them at `/`):

| file                            | consumer                                                  |
| ------------------------------- | --------------------------------------------------------- |
| `favicon-32.png`                | browser tab (declared in `src/renderer/index.html`)       |
| `apple-touch-icon.png` (180px)  | iOS "Add to Home Screen"                                  |
| `icon-192.png` / `icon-512.png` | `manifest.webmanifest` (PWA install, Android home screen) |

These are **full-bleed**: the script renders `resources/icon.svg` as-is (the artwork is already
full-bleed; only the native sizes get the widened viewBox described above). iOS applies its own
22.375% corner mask to `apple-touch-icon` (the SVG's `rx` is exactly that value), so handing it the
artwork with a transparent margin would shrink the
icon on the home screen and leave a ring of wallpaper around it. `manifest.webmanifest` declares
`display: standalone` — inert for a plain-HTTP LAN page (browsers only apply it to installed apps),
but it makes the served page installable as a real web app once it is reached over HTTPS.
