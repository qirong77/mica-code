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

The Chat tab talks to the Mica CLI via `mica app-server`, a per-chat-node resident process speaking the Codex v2 App Server protocol subset over stdio (JSON-RPC style, one JSON object per line): the app sends `initialize`/`thread/start`/`turn/start`/`turn/steer`/`turn/interrupt` and consumes v2 notifications (`turn/started`, `turn/completed`, `item/agentMessage/delta` for text, `item/reasoning/textDelta` for thinking, `item/commandExecution/outputDelta` plus `item/started`/`item/completed` for tool calls — pending then completed with the same item id, `thread/tokenUsage/updated` for usage). Mica extension notifications surface long-lived host state: `mica/queue/*` for the after_iteration queue and `mica/backgroundTasks/updated`/`mica/subagentTasks/updated` snapshots for background shell tasks and running subagents (including background subagents still active after the parent turn), which the renderer keeps as resident rows above the composer — the same task status area the CLI shows above its input. Those rows are actionable: clicking one opens a live detail modal (a background task's output tail, or a subagent's transcript — prompt, thinking, streamed text, tool calls with their arguments and results, final result and usage) that polls every second while the task runs and stops once it finishes; a background task's trailing ✕ stops it after a second confirmation. Both go through Mica extension requests (`mica/backgroundTasks/kill|output`, `mica/subagentTasks/detail|kill`) rather than the snapshot, because the snapshot deliberately carries only running tasks and the task records live in the host process: a background task's `output` response therefore carries its own task projection (final status and exit code included), and a subagent's transcript is fetched on demand so it never bloats the per-second push. The runtime (`src/host/chat.js`) maps these notifications back to the renderer's internal event shape (forwarding each `thread/tokenUsage/updated` as it arrives, so the composer status line's tokens/cached/ctx keep refreshing during long turns instead of only at `turn/completed`; those figures come from `tokenUsage.last`, the current context occupancy), paces adjacent text/reasoning deltas, and keeps the host alive across turns (skipping process startup, session reload and MCP re-init; Shift+Tab steers into the active turn for after_iteration injection, plain Tab queues locally for after_turn). Aborts send `turn/interrupt` instead of killing the process (SIGTERM fallback). Conversation history plus model/context metadata is read from `~/.mica/sessions/*.json` when a session is reopened, and turn lifecycle notifications are posted to the local notify server so sidebar dots and unread badges behave exactly like PTY-hosted Mica sessions.

The sidebar intentionally has four activity indicators sharing one fixed row-leading slot (`RowLeading`, always `w-4` so every row keeps the same title indent): a green dot breathing while a Mica turn is running (`chat-dot-running`), the terminal icon while that session has a long-running terminal foreground process, a blue dot marking a result the user has not read yet, and a steady red dot for a turn that never finished normally. The terminal icon owns the slot when both apply, with the unread/red dot stacked on its top-right corner; running takes precedence, and merely opening an idle session never creates a status dot. The red dot is a session *state*, not an unread badge: it clears only when a later turn completes (reading the session does not clear it), it covers a turn that ended in error as well as the `running` residue of a process that died mid-turn, and it deliberately excludes user-requested aborts (`turn.aborted`) and sessions another process is actively running. That last distinction is decided host-side in `session-lease.js` — a persisted `turnState: "running"` only reads as interrupted once nobody holds the session's `sessions/.turn-locks/<id>.lock`, so a TUI running the same session in another terminal is not mislabelled, and the same probe read the other way sets `remoteRunning` for a session whose lease is alive right now — another window, the other runtime instance on the same machine, or a terminal — which breathes green instead of looking idle (the host attaches both flags to the session meta rows). A live turn lease also blocks writes: `chat:start`/`chat:edit-message` refuse a session another process is running (the app rolls the optimistic message back). Within one runtime that is rarely the case, because the workspace is shared — every window has the same chat nodes, so a second window is attached to the same run and streams the same turn live (there is no per-window "another window is running this" state any more). Only another *process* (a TUI, `mica exec`, or a second runtime instance) leaves a page without any event stream: `chat:is-running` then reports `remoteRunning`, the composer shows 正在另一个进程里运行 and disables send until the lease is released. Recent rows keep the working directory base name as muted text at the *end* of the row (next to the relative time), so sessions from different projects stay distinguishable without pushing the titles out of their column. Closing a conversation is no longer a hover affordance on the left, and the row's context menu (right-click, or long-press on touch) now owns **deleting** it instead: 删除对话 is always offered (independent of whether the tab is open, since it removes the session from disk rather than closing a tab — the tab keeps its own close button), asks for confirmation, and goes through the host's `stats:delete-session` (`src/host/session-delete.js`): the session file and its `sessions/.turn-locks/<id>.lock` go away along with the dangling pin / project-assignment / sort entries. A turn that is still running is refused — this process's chat turns via `isChatSessionRunning`, and a TUI running the same session in another terminal via the turn-lease liveness probe — because that turn would write the file back.
Folding a row away never hides its activity. When a session ends up invisible — inside a collapsed group, a collapsed section, or the Recent overflow behind Show more — the first visible ancestor speaks for it by stacking the very same dot on the top-right corner of its own icon (the leading column is the chevron, the icon column holds the folder/section icon, so the badge is an overlay and never costs a column). `RowBadge` reuses the `chat-dot-running`/`chat-dot-unread` styling and the merge rule in `session-state.js` (`mergeRowStates`, running > unread), and `collectGroupStates` walks a group's whole subtree so a nested session or draft counts for every ancestor above it. The red dot deliberately does not float up: an interrupted turn is a property of one session the user has to open to act on, so it stays on its own row and a collapsed container never turns red. Exactly one visible row carries it: a collapsed section's header, a collapsed group's folder icon, or the Show-more row for the Recent overflow — an expanded section never speaks for what Show more trims, and an expanded group leaves the badge to its own rows.


The sidebar has three sections in a fixed order — **Pinned**, **Projects**, **Recent** — and a session lives in exactly one of them. `stats:move-session` (host `session-projects.js` + `session-pins.json`) is the single "change section" entry point: it writes the pin flag and the project assignment together, so no session is ever listed twice. Dragging is the same call — dropping onto another section (or another group) is a *move*, and only same-section drops with a matching working directory reorder rows. Dragging a *group* instead re-parents it: dropping it on another group row nests it there and dropping it on the Projects header moves it back to the root (`stats:move-project-group` → `moveGroup` in the same host module), while a group's own subtree, itself and its current parent are refused so the tree cannot cycle. Every drop decision is the pure `resolveDrop` in `src/renderer/src/session-dnd.js` (unit-tested because HTML5 drag cannot be driven from an automated browser); the section headers accept sessions/drafts by default, and only the Projects header accepts groups. Pinning, in turn, clears the project assignment, so the section is a property of the session rather than a tag it can accumulate.

**Projects** holds arbitrarily nested groups (`session-projects.json`: a flat `groups` array with `parentId` plus an `assignments` map, normalized on every read — dangling parents and cycles collapse to the root). A group row leads with the collapse chevron and a folder icon (open while expanded, closed while collapsed), like the section headers above it. Every sidebar row — section header, group, session — is the same `[action column][icon column][name]` grid (both leading columns are `w-4`) (`SessionTree.jsx`'s `ROW_PAD`/`COLUMN`/`GAP`/`TREE_STEP`/`NAME_OFFSET`/`Slot`), so a session's title, its group's name and the section label all land in the same column; a session keeps the leading column empty and puts its status indicator (`RowLeading`) in the icon column, Nesting costs exactly one step, and only for containers: a *nested group* moves right by `TREE_STEP` (one `w-4` column plus `gap-2`, `24px`, so the child group's chevron sits on its parent's icon column), while the sessions and drafts inside a group stay in that group's own name column - a session in a first-level group therefore lands on exactly the same column as a Recent session, and the tree never uses more than that one indent distance. Re-using that grid is mandatory for any new row type — and for the empty-state hints and the Show-more row. A group row reveals a `+` (new session inside it) and a more-actions button on hover — always visible below `md`, where there is no hover — and its context menu owns 在此新建会话 / 新建子分组 / 重命名分组 / 删除分组; the section header's `+` creates a root group. Deleting a group drops its whole subtree and releases its sessions back to Recent. A session created inside a group starts in that group's working directory: `resolveGroupCwd` walks the group's subtree for the most recently updated session that has a `cwd`, then its ancestors, and only then falls back to the usual default. The freshly created draft is filed under its group immediately (`draftGroups` in `App.jsx` is page-local bookkeeping — the draft's *text* lives in the shared UI state, but which group a tab was started from is only needed until it has a session id), and the assignment is written for real the moment the draft gets a session id.

Group ordering is stored in `session-sort.json` under a per-group key (`project:<groupId>`, alongside the existing `pinned`/`recent` lists), so each group keeps its own manual order and a stale key left behind by a deleted group is harmless.

The Files tab's activity bar mirrors VS Code with four entries: Explorer, Search, Source Control (`CHANGES`) and a `GIT TREE` panel that roots the same change tree at the current branch. While the workspace is dirty the source-control icon carries an orange badge with the changed-file count, and the explorer decorates changes the way VS Code does — a changed file takes its status colour (gold modified, green added, red deleted) plus a trailing `M`/`A`/`D` letter, and every folder above it inherits the most significant status of its subtree and shows a dot. Status letters, colours, the folder roll-up and the repository-relative path helper live in `src/renderer/src/git-decorations.js`. The explorer header follows the VS Code layout too: the folder's base name in bold (the absolute path only survives as the tooltip) plus four buttons — new file, new folder, collapse all — the latter dropping loaded subtrees so expanding re-reads them — and a more-actions menu holding refresh, collapse all, go to the parent directory, reveal in file manager and copy path. Menus share one floating layer (`FloatingMenu`) whose anchor buttons opt out of the press-to-close rule, which is what lets the more-actions button toggle its own menu. Entries matched by `.gitignore` — files and folders alike — render greyed out (dimmed label, desaturated icon) while staying fully interactive: the flag rides on the host's `files:list`, which asks `git check-ignore --stdin` once per directory listing (`src/host/git-ignore.js`; paths outside a repository, or a machine without `git`, simply mark nothing) because the rules deciding it live in `.gitignore` files, `.git/info/exclude` and the user's global excludes rather than in the path. Picking a file in `CHANGES`/`GIT TREE` opens the lazily-loaded `GitDiffEditor`, which lands on the first change (`revealFirstDiff`) instead of the top of the file, and leaves the layout to Monaco: side-by-side while the editor pane is wider than the inline breakpoint, inline diff once the pane is narrower, so a narrow right panel never squeezes two unreadable columns.

Chat Markdown uses `react-markdown` with GFM support. Raw HTML is not rendered; tables, task lists, fenced code, nested lists and streaming incomplete blocks are handled by the parser, while code blocks, messages and tool details expose copy actions. `TodoWrite` drives a plan dock above the composer, and Agent/background-shell calls receive dedicated activity summaries.

The Chat view keeps the same minimal status line as the Mica terminal: the left side shows the running indicator, and the right side shows `model_effort` and context usage as plain text. A single-line bar above the transcript always shows the newest sent user message (`lastUserPromptText`, ellipsised; queued messages stay in the queue dock instead), so the current task stays visible while scrolling. Double-clicking a user message swaps its text for an inline editor whose bottom-right corner carries Cancel / Confirm; Confirm is enabled only while Mica is idle (`canSubmitMessageEdit`, unit-tested) and calls the host's `chat:edit-message`, which asks the app-server for `mica/turn/editMessage` (`MICA_METHODS`): the session history is truncated at that message — located by whitespace-folded text plus an occurrence counter, because persisted messages carry no ids — saved, and rerun with the edited text. The `mica/sessionHistory/replaced` notification then swaps the transcript, so everything that followed the edited message leaves the context instead of staying in it. Clicking the model text opens a selection panel (catalog from `mica models`), clicking the `ctx` text opens a context-usage modal with a token bar and the same breakdown as `/context`; model and effort apply on the next message via `--model`/`--variant` overrides; the arrow left of the composer shows and switches the role, which rides on the next `turn/start` (`buildTurnStartParams`, Mica's `role` extension) so the resident host switches without respawning. Every choice made here lands in the session snapshot, which is why reopening a session restores the model, effort and role it was last used with. The app footer pairs the Git branch (left) with the working directory (right), and both always describe the same directory: the active chat node's working directory, never the `cd` of a shell running in the terminal tab. Clicking the directory opens a picker (recent directories aggregated from session history, a system folder chooser, and manual input); switching re-points the current chat and becomes the default directory, so New Session starts in the most recently used directory. Typing `@` opens a file completion and `/` a skill completion above the composer, and picking a candidate only inserts text into the input (`@src/a.ts ` for a file, `/ask ` for a skill) — nothing runs and Enter still just sends the message. `/` lists the skills of the session's working directory plus `$MICA_HOME/skills` (host `skills:list`, `src/host/skills.js`), while `@` reuses the host's fuzzy file search (`files:find`, debounced) so the candidates match what the Files tab would find; `↑↓`/Enter/Tab pick a candidate and Esc dismisses the list. Chat commands (compact local/model, clear, commit, fork) keep living on the transcript's context menu (`ChatContextMenu`, also reachable by long-press on touch). Auto-scroll follows output only while the reader remains near the bottom, with resize anchoring for streaming Markdown and reasoning.
Pasting an image into the composer saves it into `~/.mica/images/` (mirroring the terminal input) and inserts an `[Image](...)` ref; the headless run resolves the ref into a multimodal content block before calling the model, so vision-capable models see the pasted image directly. Models whose API rejects image input (e.g. DeepSeek chat completions) surface the provider error in the conversation instead. The photo button next to send covers the same path for devices without a clipboard paste (phones): it opens a file picker limited to the formats the CLI can read (`accept="image/png,image/jpeg,image/webp,image/gif"`, which is also what makes iOS transcode HEIC to JPEG), uploads every selected file through `POST /api/paste-image`, and inserts the refs at the caret. `saveImageDataUrl` (`src/host/chat-images.js`) names the stored file after the data URL's media type — falling back to magic-byte sniffing — instead of always writing `.png`, which is what previously mislabelled a pasted JPEG.

The right-hand panel (Files / Terminal) belongs to the session shown in the main area, and switching conversations switches the whole panel with it. The Files tree roots itself at that session's working directory (the same directory the footer shows), and terminals belong to the session that opened them (`rightTermsByChat` in `App.jsx`, keyed by chat node id, with `allRightTerms` handed to `TerminalHost` so other sessions' panes stay mounted and only get hidden) — switching back therefore restores the shells you left running instead of dropping you into the previous project's directory. Opening the terminal tab in a session that has no terminal creates one on the spot; a session you merely click through never spawns a PTY. When the session's path changes (the footer picker, or a resumed session) the terminals left behind in the old directory are disposed and respawned at the new one, while a terminal running a foreground process is left alone — restarting it would kill whatever the user started (`staleRightTermIds` in `src/renderer/src/right-terms.js`). Because every terminal is a real PTY, the panel sweeps itself every 10 minutes: a session untouched for 8 hours releases its whole group, and within a session still in use only terminals with no activity for 8 hours are released, so a long-lived app does not accumulate shells for conversations the user has moved on from. A terminal running a foreground process and the session currently on screen are always kept, and a released terminal simply comes back in its session's directory the next time it is opened. Closing a session reclaims its terminals too.

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

The renderer bundle is minified and split into on-demand chunks:

- `electron.vite.config.mjs` sets `build.minify: true` explicitly — electron-vite leaves `minify`
  off for all three (main / preload / renderer) segments, so without the override the page ships a
  ~11.5 MB unminified bundle. With it plus `React.lazy`, the entry chunk is ~0.5 MB.
- Monaco (the file editor and Git diff) is never in the startup path. `monaco.js` exports only the
  pure helpers plus `loadMonaco()`; the editor itself lives in `monaco-runtime.js`, which is reached
  by a dynamic import and by the lazily-loaded `GitDiffEditor`. `FilesView` creates its editor through
  `ensureEditor()` on the first file open, so ~3.7 MB of Monaco is fetched only when you actually open
  a file.
- Everything heavy is a separate chunk: `FilesView`, `TerminalHost` (xterm), `StatsView`,
  `SettingsView`, `QuickSearch`, `GitDiffEditor`.
- The 1500+ file-type icons are emitted as individual assets (`?url&no-inline`); inlining them put
  ~2.2 MB of data URIs into the entry chunk.
- The runtime's static handler gzips text assets on the fly and marks content-hashed assets
  `immutable`, so the Monaco chunk crosses a LAN at ~0.9 MB instead of ~3.7 MB, and repeat loads come
  from cache. This is deliberately local rather than a CDN: the page's CSP is `script-src 'self'`, and
  both the Electron window and the LAN mode must work offline.

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

- `src/host/` — the business core (terminals, chat, files, Git, stats, workspace, configWeb, notify
  server). It runs inside the runtime process only.
- `src/server/` — the runtime. A dependency-free Node HTTP + SSE server that hosts the renderer
  bundle and exposes `src/host` over `/api`. `vite.server.config.mjs` aliases `electron` to
  `src/server/electron-shim.js`, which implements the exact surface those modules use
  (`ipcMain.handle`, a shared `event.sender`, `app.getPath`, `shell`, `clipboard`, `dialog`).
- `src/main/index.js` — the Electron container. It spawns the runtime
  (`ELECTRON_RUN_AS_NODE`), loads the window at the runtime URL, mirrors unread notifications onto
  the dock badge (and flashes the taskbar on Windows), and stops the runtime on quit. It registers
  no business IPC and injects no preload: the page always builds `window.mica` from HTTP + SSE, so
  the window and a phone browser run byte-identical UI code. It also owns the navigation policy and
  one window per server — title suffix, badge subscription and ⇧⌘M are tracked per window — see
  *Switching Mica servers* below.
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
  (`terminal:data|exit`, `chat:event|exit|queue-state|queue-error|commit-exit`, `notify:changed`,
  `ui-state:changed`).
  Events are broadcast to every connected client, so a phone and a desktop tab share one state.
- `GET /api/env` returns `platform` / `homeDir` / `runShellLogConfig`; the renderer fetches it
  before mounting and installs `window.mica` (see `src/renderer/src/transport.js`).
- `GET /api/image?path=...` serves pasted and attached images, replacing the `file://` URLs that
  only resolve inside Electron.
- `MICA_DESKTOP_USER_DATA` (the container passes `app.getPath('userData')`) and the shim default
  resolve to the same `mica-code-app` directory, so `ui-state.json`, `file-order.json` and
  `session-pins.json`, `session-projects.json` and `session-sort.json` are shared between the
  desktop app and a standalone runtime.

### Single-instance state

The workspace is one thing, not one per tab: the runtime owns the UI state and every page renders
that same state, so a second window (or a phone on the LAN) is another view of the same workspace
rather than a separate session. `src/host/ui-state.js` keeps a flat key/value table, persists it to
`userData/ui-state.json` (atomically, debounced) and broadcasts changed keys over SSE; the page side
(`src/renderer/src/ui-state.js`, pure semantics shared through `packages/mica-web-shared`) reads it
through `ui-state:get` before mounting and writes through `ui-state:patch`.

That covers everything the user would otherwise lose: the unsent text in a composer per chat node
(`drafts`, so leaving a tab, reloading, opening a second window or restarting the app all keep it),
the open chat tabs and folder tree (`workspace`), the panel widths / collapse and current tab and
main view (`layout`), the last working directory, and the turn-log height. Two consequences worth
knowing when changing this code: an echo of your own write can arrive after you have already
written something newer (drags and typing write several times a second), so echo suppression is
keyed by *key + value* and claims every broadcast (`claimUiStateEcho`) — comparing against "the
last value I wrote" is not enough; and the draft table must not be read through React rendering in
`App.jsx` (that would re-render the whole sidebar on every keystroke), which is why the sidebar
markers go through `subscribeUiState` and the reference-stable `draftMarkers`.

Right-side panel terminals are the one piece still owned per page: the PTYs live in the runtime and
their output is broadcast to everyone, but creating, respawning (`staleRightTermIds`) and reclaiming
them are single-writer operations that would fight each other from two pages, so sharing that list
needs an owner rule first.

### Switching Mica servers

A window can point at another machine's Mica runtime: hovering the sidebar's `Server` row floats a card next to it (`ServerCard.jsx`) with the current server, the servers you have connected to, the `本机` way back and an address field — the card is deliberately not a modal, so nothing blocks the rest of the UI. On a touch screen there is no hover, so tapping the row expands the same card in place inside the drawer. A page is served by whichever runtime hosts it, so "which server am I on" is just `location.origin` — nothing is proxied and no cross-origin call is made.

Switching opens that address in **a new window** (desktop app) or **a new tab** (browser), so the server you are on keeps its own window instead of being replaced. `renderer/src/servers.js` picks the branch by user agent (`isElectronShell`): inside the container it hands the navigation to the shell (`location.assign`, intercepted by `will-navigate`), anywhere else it calls `window.open(url, '_blank')` and severs `window.opener` afterwards — deliberately not the `noopener` feature string, which makes `window.open` return `null` and would hide a blocked popup — falling back to the current tab when the popup *is* blocked.

The one thing the page cannot do itself is delegated to the runtime (`src/host/servers.js`, pure logic in `servers-core.js`): probing `GET /api/health` on the target, because a cross-origin `fetch` from the page is unreadable under CORS. Everything else is page-side: a successful probe is recorded by `servers.js` in `localStorage` (key `mica-servers`, newest first, eight addresses max, deduplicated by host) and rendered as rows in the same style as the current server, so getting back to a machine is a click instead of retyping its address. There are no notes and no manual add/remove — the list only ever holds addresses that answered as a Mica Code runtime, and it follows the page's origin, so a window on another machine has its own list. The `本机` entry is the fixed `http://127.0.0.1:8787` shortcut, only offered while the page is hosted by a non-loopback runtime (when it is, you are already home); the current server and that shortcut never appear twice in the list.

The container owns the navigation policy and one window per server (`src/main/index.js`). `will-navigate` lets a window's own origin (and the local page) navigate in place, hands the navigation to the window that already shows that server (focused, not reloaded), otherwise opens a new window when `/api/health` of the target reports `app: 'mica-code-app'`, and sends everything else to the system browser. Each window keeps its own state — `did-navigate` re-points that window's unread-badge subscription at the origin it shows and appends `— host:port` to its title, and the dock badge reflects the focused window. The first window is the local one and closing it only hides it; windows opened for other machines close for real. The app always starts on the local runtime (there is no "last server" record to restore). Because the server you switch to may be running an older bundle with no switcher of its own, **⇧⌘M** (shell level, `before-input-event`) always brings the local window to the front (loading it into the current window if it is gone), and the boot-error page offers 返回本机 whenever the current origin is not loopback — that click reloads the local page rather than focusing a window when the error page *is* the local window, so it stays a recovery action.

### What the page does differently from a native app

- **Folder pickers become in-app.** `dialog:select-directory` has no browser equivalent, so
  `CwdModal` opens `DirectoryPicker`, which browses the _server's_ filesystem through `files:list`.
- **Clipboard writes happen in the browser.** `files.copyPath` / `copyRelativePath` copy locally via
  `navigator.clipboard` with an `execCommand` fallback (a plain-HTTP LAN page is not a secure
  context). `files.reveal` still opens the containing folder on the server machine.
- **External links open in the browser tab**, not on the server.
- **Terminal file links open the in-app editor** instead of VS Code: the transport dispatches a
  `mica:open-file` event that `App.jsx` routes to the Files panel.
- **Settings is inlined, not framed.** The view renders the config page components from
  `packages/mica-config-ui` directly and gets its data through `config-web:invoke`
  (`src/host/configWebData.js`, which reads this machine's `$MICA_HOME`). Nothing is spawned and no
  iframe is used, so the page always configures the runtime that serves it — switching to another
  server configures *that* machine.
- **Window focus/visibility comes from the page**: `document.visibilityState` plus `focus`/`blur`.
- **Row drag & drop is plain HTML5 DnD.** Section changes go through one `stats:move-session`
  call rather than a client-side list juggling act, which is also why the sidebar in two browser
  tabs (or on a phone) converges instead of each client keeping its own copy of the sections.

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
terminal key bar rise above the keyboard instead of being covered by it (Android additionally gets
`interactive-widget=resizes-content` in `index.html`, which resizes the layout viewport too —
Safari ignores that key).

Height alone is not enough on iOS: to reveal the focused input Safari also shifts the whole layout
viewport, reported as `visualViewport.offsetTop`. By then the app has already shrunk to the visible
height, so without compensation it hangs off the top of the screen and leaves a blank strip below —
the composer ends up under the status bar. The same hook therefore writes that shift into
`--vvh-top` and the narrow-screen `#root` is `position: fixed` plus `translateY(var(--vvh-top,
0px))`. The fixed positioning is load-bearing: `html`/`body` are `overflow: hidden` at that same
visible height, so an in-flow root would be clipped the moment it is translated.

Neither number is taken at face value, and both decisions live in the pure
`viewport-metrics.js` (unit conversion, rounding, thresholds — the renderer only writes the CSS
variables):

- **Height**: iOS 26 can leave `visualViewport.height` untouched when the keyboard opens while the
  layout viewport (`window.innerHeight` / `documentElement.clientHeight`) does shrink, so the
  height is the smallest signal that is at least `KEYBOARD_MIN_INSET` (80px) shorter than the
  layout viewport. Anything smaller is treated as viewport jitter rather than a keyboard, which
  would otherwise shave a blank strip off the app.
- **Shift**: `--vvh-top` is only written once the height actually accounts for the keyboard (the
  app is already shorter than the layout viewport). Without that check the compensation is applied
  to a full-height app as well, and it then cancels the very shift that brings the composer above
  the keyboard — the composer stays hidden behind it.
- The shift only applies while unzoomed, since the same value during pinch-zoom comes from
  panning, not the keyboard. The hook re-measures on `visualViewport` resize/scroll plus
  `window.resize`, `orientationchange` and `document` focusin/focusout, and re-reads the values a
  few more times after each (`SETTLE_DELAYS`): the numbers settle after the event, and some OS
  versions never fire one.
- **That height must not be injected away.** The narrow-screen rule is `html body #root { height:
  var(--vvh, 100dvh) }` rather than `html, body, #root`, because a later stylesheet from the
  embedded config page used to ship a plain `html, body, #root { height: 100% }` of the same
  specificity (the SettingsView chunk loads right after boot, since the view stays mounted in a
  `Suspense` boundary), which silently won and left the app full height forever — the composer
  stayed behind the keyboard while `--vvh` was computed perfectly. Page-level height chains belong
  to whichever host owns the whole page, never to the shared config stylesheet.

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
