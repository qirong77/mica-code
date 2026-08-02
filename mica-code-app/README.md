# mica-code-app

Mica Code is a compact Electron workspace with session management, file editing, workspace search, Git diff views, and a web-style chat view for driving Mica conversations.

The Chat tab replaces the old terminal-hosted Mica view: every message spawns a `mica run --format json --thinking` child process (NDJSON event stream over stdout) and renders reasoning / text / tool calls / finish states as a terminal-style web conversation. Sessions are shared with the Mica CLI (`~/.mica/sessions`), so conversations started in the terminal or the app can be resumed in either place. The Git status bar opens a VS Code-style branch picker for searching and switching local branches and creating branches from the current or a selected ref.

## Tech stack

- Electron + electron-vite
- React 19 + React DOM
- Vite + `@vitejs/plugin-react`
- Tailwind CSS v4 + `@tailwindcss/vite`
- xterm.js for the terminal tab
- Monaco Editor for file editing and Git comparisons
- lucide-react for product icons

## Chat protocol

The Chat tab talks to the Mica CLI via its existing headless protocol:

```bash
mica run --format json --thinking [--session <id>] [--dir <cwd>] [--max-turns <n>] "<prompt>"
```

Stdout is NDJSON with `step_start` (carries the session ID), `reasoning`, `text`, `tool_use`, `error` and `step_finish` events. Tool calls arrive first as `pending` and later as `completed` records with the same call ID. `--thinking` is opt-in at the CLI protocol level so existing Multica consumers keep their compact output; the app enables it for a bounded live Thought preview that remains available after the turn. The main process (`src/main/chat.js`) spawns one child per turn, paces adjacent text/reasoning deltas before forwarding them, supports abort via SIGTERM (with a SIGKILL fallback), and reads conversation history plus model/context metadata from `~/.mica/sessions/*.json` when a session is reopened. Turn lifecycle notifications are posted to the local notify server so sidebar dots and unread badges behave exactly like PTY-hosted Mica sessions.

The sidebar intentionally has only two activity indicators: a breathing green dot while a Mica turn or terminal process is running, and a blue dot once the result is unread. Merely opening an idle session never creates a status dot; running takes precedence if both flags are present.

Chat Markdown uses `react-markdown` with GFM support. Raw HTML is not rendered; tables, task lists, fenced code, nested lists and streaming incomplete blocks are handled by the parser, while code blocks, messages and tool details expose copy actions. `TodoWrite` drives a plan dock above the composer, and Agent/background-shell calls receive dedicated activity summaries.

The Chat view keeps the same minimal status line as the Mica terminal: the left side shows the running indicator, and the right side shows `model_effort` and context usage as plain text. Clicking the model text opens a selection panel (catalog from `mica models`), clicking the `ctx` text opens a context-usage modal with a token bar and the same breakdown as `/context`; both apply on the next message via `--model`/`--variant`/`--role` headless overrides that persist into the session snapshot. The working directory lives in the app footer (the git root path) — clicking it opens a directory picker (recent directories aggregated from session history, a system folder chooser, and manual input); switching re-points the current chat and becomes the default directory, so New Session starts in the most recently used directory. Typing `/` opens a Web command palette for the remaining Chat commands (`/help`, `/status`, `/rename`, `/resume`, `/todo`, `/config`, `/compact`, plus explicit `/model` `/effort` `/role` values); `/compact` runs the headless `mica compact --session <id>` (same `CompactionService` as the terminal, with a busy guard and a before/after token summary) and refreshes the conversation. Remaining selector-heavy Ink commands like `/rewind` are never sent to the model and instead offer a copy-and-open-Terminal handoff. Auto-scroll follows output only while the reader remains near the bottom, with resize anchoring for streaming Markdown and reasoning.
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
$ npm run dev
```

### Renderer production build

```bash
$ npm run build
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
