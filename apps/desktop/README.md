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
- xterm.js for the terminal panel
- Monaco Editor for file editing and Git comparisons
- lucide-react for product icons

## Chat protocol

The Chat tab talks to the Mica CLI via `mica app-server`, a per-chat-node resident process speaking the Codex v2 App Server protocol subset over stdio (JSON-RPC style, one JSON object per line): the app sends `initialize`/`thread/start`/`turn/start`/`turn/steer`/`turn/interrupt` and consumes v2 notifications (`turn/started`, `turn/completed`, `item/agentMessage/delta` for text, `item/reasoning/textDelta` for thinking, `item/commandExecution/outputDelta` plus `item/started`/`item/completed` for tool calls — pending then completed with the same item id, `thread/tokenUsage/updated` for usage). Mica extension notifications surface long-lived host state: `mica/queue/*` for the after_iteration queue and `mica/backgroundTasks/updated`/`mica/subagentTasks/updated` snapshots for background shell tasks and running subagents (including background subagents still active after the parent turn), which the renderer keeps as resident rows above the composer — the same task status area the CLI shows above its input. Those rows are actionable: clicking one opens a live detail modal (a background task's output tail, or a subagent's transcript — prompt, thinking, streamed text, tool calls with their arguments and results, final result and usage) that polls every second while the task runs and stops once it finishes; a background task's trailing ✕ stops it after a second confirmation. Both go through Mica extension requests (`mica/backgroundTasks/kill|output`, `mica/subagentTasks/detail|kill`) rather than the snapshot, because the snapshot deliberately carries only running tasks and the task records live in the host process: a background task's `output` response therefore carries its own task projection (final status and exit code included), and a subagent's transcript is fetched on demand so it never bloats the per-second push. The runtime (`src/host/chat.js`) maps these notifications back to the renderer's internal event shape (forwarding each `thread/tokenUsage/updated` as it arrives, so the composer status line's tokens/cached/ctx keep refreshing during long turns instead of only at `turn/completed`; those figures come from `tokenUsage.last`, the current context occupancy), paces adjacent text/reasoning deltas, and keeps the host alive across turns (skipping process startup, session reload and MCP re-init; every busy Enter/Tab/Shift+Tab steers into the active turn for after_iteration injection, so a queued message lands at the next tool-call iteration instead of waiting for the whole turn to finish). A waiting message can be pulled back into the composer exactly like the CLI's shift + ← (the queue dock row also carries a recall button): `chat:recall-queued` empties whichever slot holds it — the local after_turn queue, or the host's after_iteration slot through `mica/queue/recall` — and the recalled text is restored into the input, so the composer never becomes read-only just because a message was queued. Aborts send `turn/interrupt` instead of killing the process (SIGTERM fallback). Conversation history plus model/context metadata is read from `~/.mica/sessions/*.json` when a session is reopened, and turn lifecycle notifications are posted to the local notify server so sidebar dots and unread badges behave exactly like PTY-hosted Mica sessions.

The sidebar intentionally has four activity indicators sharing one fixed row-leading slot (`RowLeading`, always `w-4` so every row keeps the same title indent): a green dot breathing while a Mica turn is running (`chat-dot-running`), the terminal icon while that session has a long-running terminal foreground process, a blue dot marking a result the user has not read yet, and a steady red dot for a turn that never finished normally. The terminal icon owns the slot when both apply, with the unread/red dot stacked on its top-right corner; running takes precedence, and merely opening an idle session never creates a status dot. The red dot is a session _state_, not an unread badge: it clears only when a later turn completes (reading the session does not clear it), it covers a turn that ended in error as well as the `running` residue of a process that died mid-turn, and it deliberately excludes user-requested aborts (`turn.aborted`) and sessions another process is actively running. That last distinction is decided host-side in `session-lease.js` — a persisted `turnState: "running"` only reads as interrupted once nobody holds the session's `sessions/.turn-locks/<id>.lock`, so a TUI running the same session in another terminal is not mislabelled, and the same probe read the other way sets `remoteRunning` for a session whose lease is alive right now — another window, the other runtime instance on the same machine, or a terminal — which breathes green instead of looking idle (the host attaches both flags to the session meta rows). A live turn lease also blocks writes: `chat:start`/`chat:edit-message` refuse a session another process is running (the app rolls the optimistic message back). Within one runtime that is rarely the case, because the workspace is shared — every window has the same chat nodes, so a second window is attached to the same run and streams the same turn live (there is no per-window "another window is running this" state any more). Only another _process_ (a TUI, `mica exec`, or a second runtime instance) leaves a page without any event stream: `chat:is-running` then reports `remoteRunning`, the composer shows 正在另一个进程里运行 and disables send until the lease is released. Recent rows keep the working directory base name as muted text at the _end_ of the row (next to the relative time), so sessions from different projects stay distinguishable without pushing the titles out of their column. Closing a conversation is no longer a hover affordance on the left, and the row's context menu (right-click, or long-press on touch) now owns **deleting** it instead: 删除对话 is always offered (independent of whether the tab is open, since it removes the session from disk rather than closing a tab — the tab keeps its own close button), asks for confirmation, and goes through the host's `stats:delete-session` (`src/host/session-delete.js`): the session file and its `sessions/.turn-locks/<id>.lock` go away along with the dangling pin / project-assignment / sort entries. A turn that is still running is refused — this process's chat turns via `isChatSessionRunning`, and a TUI running the same session in another terminal via the turn-lease liveness probe — because that turn would write the file back.
Folding a row away never hides its activity. When a session ends up invisible — inside a collapsed group, a collapsed section, or the Recent overflow behind Show more — the first visible ancestor speaks for it by stacking the very same dot on the top-right corner of its own icon (the leading column is the chevron, the icon column holds the folder/section icon, so the badge is an overlay and never costs a column). `RowBadge` reuses the `chat-dot-running`/`chat-dot-unread` styling and the merge rule in `session-state.js` (`mergeRowStates`, running > unread), and `collectGroupStates` walks a group's whole subtree so a nested session or draft counts for every ancestor above it. The red dot deliberately does not float up: an interrupted turn is a property of one session the user has to open to act on, so it stays on its own row and a collapsed container never turns red. Exactly one visible row carries it: a collapsed section's header, a collapsed group's folder icon, or the Show-more row for the Recent overflow — an expanded section never speaks for what Show more trims, and an expanded group leaves the badge to its own rows.

The sidebar has four sections in a fixed order — **Pinned**, **Projects**, **定时任务** (scheduled tasks), **Recent** — and a session lives in exactly one of them. 定时任务 is filled automatically rather than by hand: `sessionSectionOf(sessionId, { pins, projects, loopSessionIds })` resolves Pinned → Projects → _a session running a scheduled loop_ → Recent, so an unclassified conversation that starts a scheduled loop moves there on its own while anything pinned or grouped stays put, and the drag rules still do not know the section.

**Projects** holds arbitrarily nested groups (`session-projects.json`: a flat `groups` array with `parentId` plus an `assignments` map, normalized on every read — dangling parents and cycles collapse to the root). A group row leads with the collapse chevron and a folder icon (open while expanded, closed while collapsed), like the section headers above it. Every sidebar row — section header, group, session — is the same `[action column][icon column][name]` grid (both leading columns are `w-4`) (`SessionTree.jsx`'s `ROW_PAD`/`COLUMN`/`GAP`/`TREE_STEP`/`NAME_OFFSET`/`Slot`), so a session's title, its group's name and the section label all land in the same column; a session keeps the leading column empty and puts its status indicator (`RowLeading`) in the icon column, Nesting costs exactly one step, and only for containers: a _nested group_ moves right by `TREE_STEP` (one `w-4` column plus `gap-2`, `24px`, so the child group's chevron sits on its parent's icon column), while the sessions and drafts inside a group stay in that group's own name column - a session in a first-level group therefore lands on exactly the same column as a Recent session, and the tree never uses more than that one indent distance. Re-using that grid is mandatory for any new row type — and for the empty-state hints and the Show-more row. A group row reveals a `+` (new session inside it) and a more-actions button on hover — always visible below `md`, where there is no hover — and its context menu owns 在此新建会话 / 新建子分组 / 重命名分组 / 删除分组; the section header's `+` creates a root group. Deleting a group drops its whole subtree and releases its sessions back to Recent. A session created inside a group starts in that group's working directory: `resolveGroupCwd` walks the group's subtree for the most recently updated session that has a `cwd`, then its ancestors, and only then falls back to the usual default. The freshly created draft is filed under its group immediately (`draftGroups` in `App.jsx` is page-local bookkeeping — the draft's _text_ lives in the shared UI state, but which group a tab was started from is only needed until it has a session id), and the assignment is written for real the moment the draft gets a session id.

Group ordering is stored in `session-sort.json` under a per-group key (`project:<groupId>`, alongside the existing `pinned`/`recent` lists), so each group keeps its own manual order and a stale key left behind by a deleted group is harmless.

**定时任务** runs the CLI's `/loop` inside the runtime, not in a page: `src/host/loop-state.js` holds the pure model (normalize / start / stop / due selection / count a round, unit-tested) and `src/host/loops.js` the host (one re-armed timer, `userData/loops.json`, the `loops:*` IPC, plus `catchUpLoops` so a loop that expired while the process was down fires once instead of replaying every missed round). A loop is keyed by the workspace **node id**, not by session id: a loop may be started on a draft that has no session yet, it fires the first round immediately, and the session id is bound on `turn/started`. Starting, pausing, resuming, editing and stopping are the same call the composer panel makes, and every change is broadcast as `loops:changed`. Each round goes through `chat.js`'s `runLoopTurn` — i.e. the chat host's own `startRun` — so a session that is already busy (or already held by another process) is _skipped_ instead of queued: the run counter stays put, the next attempt moves one interval out, and the reason lands in the row's tooltip. A round is a host-initiated turn, so the page has no optimistic bubble for it: the host pushes `chat:run-started` alongside `turn/started` (`{ id, sessionId, prompt, clientMessageId, startedAt }`) and the renderer appends the task's user message through `appendRunStartedMessage`, deduped by `clientMessageId` and by the trailing unanswered user row — without it a scheduled conversation shows the answers with no sign of what was asked until it is reopened, and it must not dedupe by text alone because every round sends the same task. The composer's clock is the **only** control surface: the section header has no `+`, a row's context menu (long-press on touch) is the ordinary session menu (pin / rename / delete / details), and nothing ever prefills a `/loop xx` command into the input — creating, re-intervalling, pausing, resuming, firing once and stopping all happen in the clock panel above the composer. Every row with a loop shows the clock icon next to its title **in every section** (a pinned or grouped conversation is never moved into 定时任务, so it must not lose the fact that it carries one) and the icon stays highlighted (`text-warn`) whether the loop is running or waiting; the tail keeps `每 30 分钟 · 3 次` and the state reads 运行中 (a round is executing right now) / 等待运行中 / 已暂停 via `loopStatusLabel(loop, running)`. The countdown still lives in the tooltip only — the tree never ticks per second. Deleting a conversation drops its loop (`stats:delete-session` → `dropLoopsForSession`).
**Session search** (the sidebar search box) is the way back to a conversation you only half-remember, and it deliberately does not keep the four sections: as soon as there is a query the sidebar renders one flat list ranked by relevance (each row carries the section or group it came from at its tail, and a second line showing _why_ it matched). `packages/mica-web-shared/session-search.ts` holds the whole matching model — case/full-width folding that is length-preserving so a match offset can be mapped back onto the original text for the snippet, multi-word AND, the score tiers (title prefix > title contains > working-directory basename > full path > id/group/scheduled-task text > body-only), match ranges, snippet extraction and the time-range arithmetic — while `src/renderer/src/session-search.js` (pure, unit-tested) merges sessions and drafts into that list. Hits are marked up with `<mark>`, so a body-only match shows the `…` context line and a path-only match highlights the path instead; nothing ever matches silently. The box itself is sticky inside the scrolling list (an opaque background keeps it above the rows) and its second line holds the range pills plus the result count — the count lives there rather than under the list because the bottom of a long list is off-screen anyway. `⌘/Ctrl+K` focuses it (not while a terminal or a text area has focus, where Cmd+K means something else), `↑↓` moves the highlight, `Enter` opens, `Esc` clears. **Body search runs host-side**: `stats:search-sessions` (`src/host/stats.js`) matches the scanner's `text` projection (`parseSessionText` in `stats-core.js`) over user/assistant text only — notices and tool payloads are ignored, a plugin-injected message contributes its `displayContent`, compact's `[Mica compact boundary]` metadata is skipped entirely (it is internal state JSON that would otherwise eat the whole budget and win every query) and a `[Mica compact checkpoint]` summary only loses its marker line. Each session is capped at `SESSION_SEARCH_TEXT_LIMIT` (20k chars), keeping the head 60% and the tail 40% (marked in the middle, reported as `textTruncated`) since a long conversation is remembered by how it started and what it was doing at the end. The default range is **the last three days** (`SESSION_SEARCH_RANGES`'s `3d`, counted back in calendar days) and sessions outside it are never parsed — which is what makes it answer in 10–30ms over a directory of a thousand sessions; choosing 全部 takes the 600 most recently updated candidates and reports `truncated: true` (roughly 0.5–0.8s on a cold cache, cached afterwards). Content hits are fetched on a 220ms debounce with a `cancelled` guard, so a slow response never overwrites a newer query; local title/path hits appear immediately and the body hits join them when they arrive.

The Files view's activity bar mirrors VS Code with four entries: Explorer, Search, Source Control (`CHANGES`) and `GIT TREE`. `CHANGES` is the VS Code view of the working tree — uncommitted changes against `HEAD` (`git:summary`, host `git.js`), the same set the activity-bar badge counts and the explorer decorates — while `GIT TREE` roots the branch's own changes (`git:branch-summary`: `merge-base..worktree`, so committed and uncommitted changes plus untracked files) under the current branch, i.e. what this branch adds on top of its base branch, which stays visible after the agent commits. The base branch is `origin/HEAD` when it exists, then `origin/master`, `origin/main`, `master`, `main` (`resolveBaseRef`); when the current branch _is_ the base — or the repository has no such branch, or is in detached HEAD — the dataset degrades to the working tree so the panel never claims "no changes" just because you are sitting on `master`. Picking a file in `GIT TREE` diffs it against the merge base instead of `HEAD` (`git:file`'s `base: 'branch'`, carried by the selection), which is what makes an already-committed branch change visible at all. While the workspace is dirty the source-control icon carries an orange badge with the changed-file count, and the explorer decorates changes the way VS Code does — a changed file takes its status colour (gold modified, green added, red deleted) plus a trailing `M`/`A`/`D` letter, and every folder above it inherits the most significant status of its subtree and shows a dot. Status letters, colours, the folder roll-up and the repository-relative path helper live in `src/renderer/src/git-decorations.js`. The explorer header follows the VS Code layout too: the folder's base name in bold (the absolute path only survives as the tooltip) plus four buttons — new file, new folder, collapse all — the latter dropping loaded subtrees so expanding re-reads them — and a more-actions menu holding refresh, collapse all, go to the parent directory, reveal in file manager and copy path. Menus share one floating layer (`FloatingMenu`) whose anchor buttons opt out of the press-to-close rule, which is what lets the more-actions button toggle its own menu. Entries matched by `.gitignore` — files and folders alike — render greyed out (dimmed label, desaturated icon) while staying fully interactive: the flag rides on the host's `files:list`, which asks `git check-ignore --stdin` once per directory listing (`src/host/git-ignore.js`; paths outside a repository, or a machine without `git`, simply mark nothing) because the rules deciding it live in `.gitignore` files, `.git/info/exclude` and the user's global excludes rather than in the path. Picking a file in `CHANGES`/`GIT TREE` opens the lazily-loaded `GitDiffEditor`, which lands on the first change (`revealFirstDiff`) instead of the top of the file, and leaves the layout to Monaco: side-by-side while the editor pane is wider than the inline breakpoint, inline diff once the pane is narrower, so a narrow pane never squeezes two unreadable columns. `CHANGES` splits itself the way VS Code does: staged work gets its own `Staged Changes` group above `Changes` (the group vanishes when empty, mirroring the `hideWhenEmpty` index group, while `Changes` stays put), and every file is filed by its porcelain `XY` code — one staged _and_ edited again (`MM`) shows up in both. Hovering a row reveals the VS Code inline actions — open file, discard changes, stage/unstage — right-aligned in front of the status letter. Those three are the app's only Git writes: `git:stage` / `git:unstage` / `git:discard` live in `src/host/git-ops.js`, which deliberately imports no Electron so `git-ops.test.js` can drive real Git against a temporary repository; `discard` is irreversible — untracked files are deleted, tracked ones restored from the index — so the renderer confirms first, naming the file. List rows hover with `--color-list-hover` (`#2a2d2e`, _darker_ than the panel, not lighter: that is VS Code's fallback `list.hoverBackground`) and a 4px radius, and the Explorer/`CHANGES` decorations use the VS Code `gitDecoration.*` palette (gold `#e2c08d` modified, green `#73c991` added or untracked, red `#f14c4c` deleted).

The tab strip follows the theme's own layering rather than the chrome colour: the empty strip is _darker_ than the editor (`--color-tabstrip`, the `editorGroupHeader.tabsBackground` VS Code falls back to because Darcula leaves it undefined), so the active tab — painted `canvas` — reads as the lighter one and merges into the editor below it. The 1px separator under the strip is therefore drawn as an inset shadow on the _inactive_ tabs (plus a `flex-1` filler for the empty area) instead of a border on the container: a container border sits outside the tab boxes and would show up under the active tab too, which is exactly the hairline VS Code does not draw. Darcula defines no `tab.activeBorderTop`, so there is no accent line across the active tab.

The `SEARCH` panel drives `files:search` (host `files.js` over the pure matcher in `src/host/search-core.js`) with the VS Code query toggles — `Aa` case, `ab` whole word, `.*` regex — and the include/exclude boxes, both using VS Code glob semantics (a pattern with no `/` matches the basename at any depth, `**` crosses directories). The host reports each hit's line, column and highlight range, because the renderer cannot recompute the match once a long line has been truncated or a regex is in play; results group by file with a per-file count, and clicking a hit opens the file at that line. An in-progress regex (`([`) comes back as a message, not an error page. Both git panels also carry a refresh button in their header (`onRefreshGit`) on top of the 10s poll.

Chat Markdown uses `react-markdown` with GFM support. Raw HTML is not rendered; tables, task lists, fenced code, nested lists and streaming incomplete blocks are handled by the parser, while code blocks, messages and tool details expose copy actions. `todo_write` drives a plan dock above the composer, and Agent/background-shell calls receive dedicated activity summaries. A user turn and a model answer are told apart by three things, and none of them is a new column: a user message sits on a raised band (`--chat-user`, the `--color-panel-hi` rung — `--color-panel` is what the compact notice already claims, so the two bands stay distinguishable), its text takes the brightest foreground rung (`--color-fg-max`) while the answer keeps the reading color (`--color-fg`), and the turn rhythm is tight inside a turn (11px before an answer) but airy between turns (20px before a prompt). Both markers and the body inset stay shared with the notices, so the `▌` column never shifts.

Quick open (`Ctrl+P`) and the full-text overlay (`Ctrl+Shift+F`) render in the same VS Code quick-pick shell as the footer's branch and directory pickers (`quick-pick-*` in `assets/app.css`): a 640px panel anchored near the top, 22px rows with the name bright and its directory dimmed, a separator between the action rows and the list, and a 520px cap so a long list scrolls instead of covering the window. Quick open goes through the host's `files:find`, which reuses the `mica-file-mentions` workspace scan and its 45s cache (100 candidates, directories filtered out because the action is opening a file) — the same names and latency the `@` completion sees — while `Ctrl+Shift+F` still drives `files:search`. An empty query shows a hint instead of enumerating the workspace. The branch picker in the footer opens the same shell and keeps each ref's git date as a Chinese relative time (`git-refs.js`), with the author/hash/subject on the row's second line.

The Chat view keeps the same minimal status line as the Mica terminal: the left side shows the running indicator, and the right side shows `model_effort` and context usage as plain text. A single-line bar above the transcript always shows the newest sent user message (`lastUserPromptText`, ellipsised; queued messages stay in the queue dock instead), so the current task stays visible while scrolling. Double-clicking a user message swaps its text for an inline editor whose bottom-right corner carries Cancel / Confirm; Confirm is enabled only while Mica is idle (`canSubmitMessageEdit`, unit-tested) and calls the host's `chat:edit-message`, which asks the app-server for `mica/turn/editMessage` (`MICA_METHODS`): the session history is truncated at that message — located by whitespace-folded text plus an occurrence counter, because persisted messages carry no ids — saved, and rerun with the edited text. The `mica/sessionHistory/replaced` notification then swaps the transcript, so everything that followed the edited message leaves the context instead of staying in it. Clicking the model text opens a selection panel (catalog from `mica models`), clicking the `ctx` text opens a context-usage modal with a token bar and the same breakdown as `/context`; model and effort apply on the next message via `--model`/`--variant` overrides; the arrow left of the composer shows and switches the role, which rides on the next `turn/start` (`buildTurnStartParams`, Mica's `role` extension) so the resident host switches without respawning. Every choice made here lands in the session snapshot, which is why reopening a session restores the model, effort and role it was last used with. The app footer pairs the Git branch (left) with the working directory (right), and both always describe the same directory: the active chat node's working directory, never the `cd` of a shell running in the terminal panel. Clicking the directory opens a picker (recent directories aggregated from session history, a system folder chooser, and manual input); switching re-points the current chat and becomes the default directory, so New Session starts in the most recently used directory. Typing `@` opens a file completion and `/` a skill completion above the composer, and picking a candidate only inserts text into the input (`@src/a.ts ` for a file, `/ask ` for a skill) — nothing runs and Enter still just sends the message. `/` lists the skills of the session's working directory plus `$MICA_HOME/skills` (host `skills:list`, `src/host/skills.js`). `@` is the same completion the terminal uses: the host's `files:mention` (debounced 100ms, immediate for an empty query) returns candidates from `packages/mica-file-mentions`, the package that also backs the CLI plugin and its input box, so both sides share one trigger rule, one workspace scan (`git ls-files` plus `fd` when present, cached per workspace and prewarmed when a run starts) and one scoring pass (basename before path, directories first, 20 candidates max, `labelHighlights` for the matched characters); nothing is re-ranked in the renderer. `↑↓`/Enter/Tab pick a candidate and Esc dismisses the list. Each row reads `name | description` (skill: `/<name>` then its description; file: file name then its workspace-relative path), the name always keeping its natural width while the description truncates, and a composer too narrow for both drops the descriptions instead of squeezing the names. The composer runs **no** input command: `send()` does no slash dispatch, so `/xxx` (including `/loop`) reaches the model as ordinary text exactly like any other prompt, and `/` only drives the skill completion. Do not reintroduce a "runnable in the composer" whitelist over `CHAT_COMMANDS` — `/` is also the skill completion (`/ask`, `/commit`…) and `/Users/qi` is just a path; capabilities that need UI (scheduled tasks and friends) belong on a panel entry instead. Chat commands (compact local/model, clear, commit, fork) keep living on the transcript's context menu (`ChatContextMenu`, also reachable by long-press on touch). Selecting text inside the transcript adds 引用 as the menu's **first** item (`readTranscriptSelection`): it quotes the selection into the composer through the same `quoteIntoDraft` path as the hover quote button, labelled 我 / 模型 when the whole selection sits in one message and 对话 when it spans messages, while selections inside the composer never produce it. Auto-scroll follows output only while the reader remains near the bottom, with resize anchoring for streaming Markdown and reasoning. The transcript also keeps its own scroll position per conversation. What actually wipes it is React _moving_ the `.chat-view` node inside its parent (which rebuilds its layout box), and that happens whenever the panes are rendered in most-recently-used order — hence workspace-node order. Hiding a pane with `display:none` alone does not reset the scroller (measured: 4511 stays 4511, while moving the same node gives 3011 → 0). `chat-scroll.js` (unit-tested) covers the two things the browser cannot: a pane rebuilt after LRU eviction, and staying pinned to the bottom when the content grew while the pane was hidden.
The composer's action strip ends with a clock that opens the loop panel (`LoopPopover.jsx`) directly above the input — the same spot and layer as the `@` completion and the model picker. It is the visual counterpart of the CLI's `/loop <interval> <task>`: the same `loops.start` call, the first round firing immediately. On a conversation that already has a loop the panel becomes its editor (interval, task, 立即执行一次 / 暂停 / 继续 / 停止), and the interval and progress strings all come from the pure `loop-command.js` so the page and the host cannot disagree. A composer whose node carries a loop also _looks_ different, mirroring the CLI's loop prompt: the container gets `.chat-composer-loop` (warning-tinted border and background), the leading marker turns into ⏰ (`.chat-prompt-mark.is-loop`) and `LoopBadge.jsx` prints the CLI-shaped badge on the top-right edge (`⏰ 每 30 分钟 · 下次 3 分 12 秒 · 第 3 次`, with 运行中 replacing the countdown while a round is in flight); that badge owns its own per-second ticker — keeping the timer in `ChatView` would re-render the whole transcript every second — and it wins the top-right slot over the queue hint. On a computer the strip deliberately has **no send button** any more: Enter (or Tab) is the gesture, leaving only the upload and clock buttons, while phones keep 发送/加入队列 because a soft keyboard has no Enter. 「停止生成」 stays on both, since it is unrelated to how a message is submitted.
The action strip also carries the CLI's **`/btw`** as a right-side **drawer**, labelled **By The Way** in the UI (the same wording the CLI's btw prompt uses) — `BtwDrawer.jsx` (`.chat-btw`), between the character-count hint and the clock, with `aria-expanded` on the trigger. The drawer is a sibling of the transcript inside `.chat-view`, not a popover: `.chat-view.chat-btw-open` reserves its strip with `padding-right: var(--chat-btw-width)` and the drawer takes the same variable as its width (`min(400px, 45%)` — both percentages resolve against the same width, so the two never overlap or leave a seam), which keeps the transcript _and_ the composer fully usable while it is open; below 768px it covers the view instead (`padding-right: 0`, `width: 100%`). It does not reuse the shared `Popover` shell and therefore does not dismiss on an outside click either — reading the main transcript while the drawer is open is the normal case, and a stray click must not throw away the half-typed question — so the ways out are the header's ✕, Esc (document-level, so it works from any focus) and the trigger itself. Questions and answers reuse the transcript's own row grammar (`.chat-message` / `-user` / `-assistant` with the `▌`/`●` markers, `.chat-markdown`, one `--chat-text-size` rung) on the content surface (`.chat-btw-body` is `--color-canvas`) while the header and input row stay on the frame color (`--color-panel`) — the user band (`--chat-user`) is only 27 levels above canvas and would be invisible on panel. It exists to be usable _while the main turn runs_ — that is the whole point — so it never queues a message, never touches the run lifecycle, and is only disabled on a draft without a session id or on `remoteRunning`, where there is no host to hold the main transcript. The panel is a _thread_, not a chat bubble: `mica/btw/ask` (`MICA_METHODS.btwAsk`) hands the question to the resident host and returns immediately, because the request loop awaits one line at a time and a synchronous model answer would block `turn/interrupt`, `turn/steer` and `mica/queue/recall` for as long as it takes. Because btw _is_ a Mica run — the same agent loop, with read-only tools — that snapshot is a **live** one: the host wires the subagent's text/thinking/tool-call/tool-result callbacks into the in-flight entry and pushes a merged whole-thread snapshot every 80ms, so the drawer renders thinking, tool rows (the transcript's own `chat-tool-views.jsx` components — wrapped reasoning text plus one-line tool rows and the shared tool detail dialog in `chat-tool-detail.jsx`, one implementation for both surfaces) and the answer as it streams, with a blinking caret on the last line. Phase labels, the header timer and the "still running" judgement are pure functions in `btw-thread.js` (unit-tested); the header's 250ms ticker lives in the drawer, never in `ChatView`. Only the entry that is running carries thinking/tool rows — the host clears them when the next question starts, exactly like the transcript's turn log describes the current turn — and every field is capped, because the whole thread is re-sent on every flush. The CLI's `/btw` deliberately installs none of these callbacks: a terminal has one notice and no room for a live transcript.

The answer comes back as a whole-thread snapshot on `mica/btw/updated` (host state, delivered like the task snapshots, never through the turn event buffer), and follow-ups continue the same isolated subagent — exactly the CLI's `/btw -continue` — while 新话题 sends `{ newThread: true }` with an empty question to reset it so the next question re-reads the main transcript. Answers are rendered with the chat's own Markdown (passed down as `renderAnswer`, so the panel never imports `ChatView` and creates a cycle), a half-typed question is kept per node like the composer draft, and if an answer lands while the drawer is closed `newlyAnsweredBtwEntries` (pure, unit-tested) adds a notice — its baseline is "that entry was still running in the previous snapshot", which is why restoring a session does not re-announce old answers. Nothing here ever enters the transcript or the provider context: btw is by definition out-of-band, and hiding it in the conversation would blur which content the model actually saw.

**自动压缩** is an official plugin (`plugins/auto-compact/`) rather than a section of the Settings page of its own: its enable switch, the two thresholds (快速压缩 at 200k, 模型压缩 at the deliberately lower 120k), the per-session limits (3 each) and the minimum interval between runs are ordinary `settings` in `plugins/auto-compact/plugin.json`, edited under Settings → **Plugins → Auto Compact** and stored in `$MICA_HOME/plugin-settings/auto-compact.json`, so every host that loads the plugin reads the same values. Its tallies (`quickRuns` / `modelRuns` / `lastRunAt`) live in the session snapshot's `pluginState['auto-compact']`, which is what keeps them per session and travelling with the conversation. Both rules are checked at the provider's iteration boundary of every completed model request — not when the whole turn finishes — so a long turn stops paying for a bloated context the moment it notices one: the local pass always goes first, and the model pass is skipped when that already brought the context back under its threshold; a one-shot `mica exec` run never compacts. Only the history sent to the model is rewritten — the transcript you are reading keeps the full conversation.

Pasting an image into the composer saves it into `~/.mica/images/` (mirroring the terminal input) and inserts an `[Image](...)` ref; the headless run resolves the ref into a multimodal content block before calling the model, so vision-capable models see the pasted image directly. Models whose API rejects image input (e.g. DeepSeek chat completions) surface the provider error in the conversation instead. The photo button next to send covers the same path for devices without a clipboard paste (phones): it opens a file picker limited to the formats the CLI can read (`accept="image/png,image/jpeg,image/webp,image/gif"`, which is also what makes iOS transcode HEIC to JPEG), uploads every selected file through `POST /api/paste-image`, and inserts the refs at the caret. `saveImageDataUrl` (`src/host/chat-images.js`) names the stored file after the data URL's media type — falling back to magic-byte sniffing — instead of always writing `.png`, which is what previously mislabelled a pasted JPEG.

The Files view and the terminal panel both belong to the session shown in the main area, and switching conversations switches them with it. Files shares the main column with the transcript: a path link in the transcript opens the file in place, while the file icon at the top-right of the chat opens Files in **its own window** instead (there is no shortcut). That window is a page of its own — `/files` on the runtime, `files.html` under the Vite dev server, one entry (`src/renderer/src/files-window.jsx`) rendering nothing but `FilesView`: no session sidebar, no 「返回对话」, no other view switches, just the tree, the editors and the source-control panels, plus a thin draggable strip because macOS hides the title bar. The button calls `window.open(detachedFilesUrl(...), 'mica-files')`, and the shell turns an `http(s)` target that is one of its own app pages (`src/main/app-page-target.js`) into an app window (`openAppPageWindow` in `src/main/index.js`); anything else still goes to the system browser. A plain browser gets a real popup and falls back to the in-place view when that popup is blocked. The directory rides in `?cwd=`, so a reload lands on the same tree and the window keeps working from a copied address; reusing one window name means clicking the icon again brings that window forward (reloading it when the directory changed) instead of stacking duplicates. Because that page has no workspace, it reads Git through `src/renderer/src/useGitWorkspace.js` — the same `git:summary` / `git:branch-summary` / `git:status` calls and the same shared `gitCompareBase` table the main window uses, so both agree on the repository, the base branch and the review state. A 「返回对话」 button appears on every non-chat view of the main window, and the tree roots itself at that session's working directory (the same directory the footer shows). The terminal is a VSCode-style panel docked to the bottom of the main column: the terminal icon next to the file icon — or `Ctrl+Backquote` — toggles it, and it listens for Ctrl only because macOS claims `Cmd+Backquote` for cycling windows, its top edge is a drag handle (the drag writes the panel's height straight to the DOM and only commits to `layout` on release, capped at ¾ of the viewport), and because it is docked rather than floating the composer stays usable while a command runs. Terminals belong to the session that opened them (`rightTermsByChat` in `App.jsx`, keyed by chat node id, with `allRightTerms` handed to `TerminalHost` so other sessions' panes stay mounted and only get hidden) — switching back therefore restores the shells you left running instead of dropping you into the previous project's directory. Opening the panel in a session that has no terminal creates one on the spot; a session you merely click through never spawns a PTY. Both surfaces mount on first use and are never unmounted afterwards (`filesMounted` / `terminalMounted`), so their chunks stay out of the startup path while reopening one keeps its open (and unsaved) files and terminal scrollback — which is also why `filesRef` may be null when a path link asks for a file: `openFileInView` falls back to `pendingFileOpenRef` and the effect flushes it once the callback ref reports the view is mounted. When the session's path changes (the footer picker, or a resumed session) the terminals left behind in the old directory are disposed and respawned at the new one, while a terminal running a foreground process is left alone — restarting it would kill whatever the user started (`staleRightTermIds` in `src/renderer/src/right-terms.js`). Because every terminal is a real PTY, the panel sweeps itself every 10 minutes: a session untouched for 8 hours releases its whole group, and within a session still in use only terminals with no activity for 8 hours are released, so a long-lived app does not accumulate shells for conversations the user has moved on from. A terminal running a foreground process and the session currently on screen are always kept, and a released terminal simply comes back in its session's directory the next time it is opened. Closing a session reclaims its terminals too.

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

### Mobile keyboard diagnostics

When the native phone keyboard fails but the simulated viewport check passes, build the renderer
and serve it against the already running desktop runtime:

```bash
npm run build:app
node scripts/serve-mobile-diagnostics.mjs
```

The script prints the LAN URL (port 18787 by default) with `?viewport-debug=1` and a temporary
NDJSON log path. `MICA_DESKTOP_PORT` selects the existing runtime port (default 8787). It proxies
requests to that runtime so the same sessions remain available without restarting the desktop app.
Reproduce in the same browser mode as the failure, including home-screen mode when applicable.
The capture records viewport and element geometry, ancestor scroll offsets, browser/mode and build
filenames. It does not read chat text, draft values, HTML, session identifiers or page query parameters,
and adds no overlay or focus/scroll changes. Recording is opt-in and requires this dedicated server;
the production runtime does not accept reports. Logs are bounded and stored only in the system temp
directory. Stop the diagnostic server with Ctrl+C after collecting the reproduction.

If the problem disappears while recording, compare with `/?viewport-debug=0` on the same server
in the same browser mode before treating it as fixed. Geometry and computed-style reads can flush
pending browser layout even though the recorder does not write styles or scroll positions. A passing
Safari tab run also does not establish that an installed home-screen app works. The diagnostic
server's manifest deliberately starts home-screen launches with recording enabled.

### Production build

```bash
$ npm run build          # = build:app (shell + renderer) + build:server (runtime)
```

`build:app` runs `build:cli` (`cd ../.. && bun run build`) first, so the repo-root CLI binary and
the `~/.local/bin/mica` launcher are rebuilt before the shell is bundled. The app resolves the CLI
through `resolveMicaExecutable()`, so skipping this step leaves the window talking to a stale binary.
Run `npm run build:server` alone when only the runtime changed and the CLI is already current.

Use `npm run build:unpack` for local verification: it runs the same build but packages with
`electron-builder --dir`, skipping the DMG/ZIP compression that dominates a release build.

Build cost is split roughly as: CLI + shell + runtime in parallel (~6s), electron-builder
packaging (~11s), zip + dmg compression (~14s). The last part compresses a 255 MB Electron
Framework and does not shrink; that is why `--dir` exists for local checks.

Build speed comes from three things, all of which are load-bearing:

- Vite 8 (Rolldown) via `electron-vite` 6. The renderer segment went from 26–29s to 4–5s.
  `electron-vite` 5 peers on vite ≤7, so the two versions must move together.
- `scripts/run-parallel.mjs` runs the CLI build, `electron-vite build` and the runtime build
  concurrently. They write to disjoint directories, so serializing them only wastes wall time.
- `tablerIconDeepImports()` in `electron.vite.config.mjs` rewrites `@tabler/icons-react` named
  imports to per-icon deep imports at build time. The upstream barrel re-exports 6197 icon
  modules, which the renderer used to parse in full; the rewrite drops 10870 modules to 4744.

Package size is decided by dependency classification, not by a file-exclusion list. electron-builder
packs every entry of `dependencies` into `app.asar`, so renderer packages live in `devDependencies`
(they are already bundled into `out/renderer` by Vite) and only `@electron-toolkit/utils`,
`@xterm/headless` and `node-pty` stay in `dependencies`. Shipping the renderer set as well used to
push `app.asar` past 200 MB (`@tabler/icons-react` alone is 91 MB of icon modules) and slowed both
asar writing and archive compression; it is now ~15 MB. Add a new package to `dependencies` only if
`src/main` requires it directly.

`renderer.resolve.dedupe` pins `react` / `react-dom` to a single copy for the same structural reason:
the config UI sources in `packages/mica-config-ui` resolve React from the repo root while the page
resolves it from `apps/desktop`, and a second instance makes hooks in the settings page read from a
null namespace (`Cannot read properties of null (reading 'useState')`).

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
  `SettingsView`, `QuickSearch`, `GitDiffEditor`. `FilesView` and `TerminalHost` are additionally
  mounted on demand (`filesMounted` / `terminalMounted`), so their chunks are not even fetched
  until the file view or the terminal panel is opened for the first time.
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
  _Dependency-free is load-bearing_: the bundle ships inside `app.asar`, which has no
  `node_modules`, so any dependency left external is a `Cannot find package …` at launch. Vite's SSR
  build externalises `package.json` dependencies by default, so the config pins
  `ssr.noExternal: true` and keeps only Node builtins plus `node-pty` external;
  `src/host/server-bundle.test.js` asserts it (skipping when the bundle has not been built). A slip
  here stays green in dev — which resolves packages from the repo's `node_modules` — and only breaks
  the packaged app.
- `src/main/index.js` — the Electron container. It spawns the runtime
  (`ELECTRON_RUN_AS_NODE`), loads the window at the runtime URL, mirrors unread notifications onto
  the dock badge (and flashes the taskbar on Windows), and stops the runtime on quit. It registers
  no business IPC and injects no preload: the page always builds `window.mica` from HTTP + SSE, so
  the window and a phone browser run byte-identical UI code. It also owns the navigation policy and
  one window per server — title suffix, badge subscription and ⇧⌘M are tracked per window — see
  _Switching Mica servers_ below.
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
$ node out/server/index.mjs --host 0.0.0.0 --port 8787 --renderer out/renderer \
    [--no-share] [--allow-missing-renderer]
```

Environment variables with the same meaning: `MICA_DESKTOP_HOST`, `MICA_DESKTOP_PORT`,
`MICA_DESKTOP_SHARE_PORT` (on/off only, see below), `MICA_DESKTOP_RENDERER`. The runtime prints both the loopback and LAN URLs
on startup, plus a machine-readable `[mica-desktop] ready {"url":…,"port":…}` line the Electron
container parses. `GET /api/health` answers whether a port is already serving Mica Code.

It listens on **one** port and distinguishes its services by path (the conventions live in
`packages/mica-web-shared/app-paths.ts`, shared with the renderer). That port's number — `8787`
unless `MICA_DESKTOP_PORT` / `--port` says otherwise — exists in exactly one place,
`packages/mica-web-shared/runtime-port.js`: the runtime, the Electron shell, the renderer's `本机`
shortcut, the Vite dev proxy and the mobile-diagnostics script all import it from there instead of
each carrying a literal. Nothing else in the app opens a TCP port:

- the controlled browser and the terminal service listen on **Unix sockets** in the app's
  `userData` (`MICA_BROWSER_SOCKET` / `MICA_TERMINAL_SOCKET`), forwarded as `/remote/*` below;
- `src/host/notifyServer.js` binds an **ephemeral** loopback port (`listen(0)`) for the duration of
  one turn — nothing ever needs to know its number;
- `scripts/serve-mobile-diagnostics.mjs` (a manual dev helper, not the app) picks the runtime port
  plus 10000 — `18787` by default — overridable with `MICA_DIAGNOSTICS_PORT`.

The paths:

- `/` and `/mica-web` — the whole app (session list, files, terminals, settings);
- `/share` — the surface a share link points at: `/share?session=<id>` opens that one conversation
  **without the left session list**, and `/share` itself is the list of links that have been shared
  (`分享链接`);
- `/terminal-control` — the terminal window page (`?session=<id>`), a separate Vite entry;
- `/remote/control/*` — the controlled browser, forwarded to the main process (below). `/remote/control`
  itself answers with the entry points (`/browser/docs`, `/browser/health`), so opening it in a browser
  tells you whether the service is up instead of a bare 404;
- `/remote/terminal/*` — the agent-facing terminal API, forwarded to the main process (below);
- `/mcp/browser` and `/mcp/terminal` — the two MCP endpoints the agent actually calls (one tool
  each, `control`; see "Controlled browser windows" below);
- `/api/*` — the runtime capabilities.

That replaces the old second listener (share port `8890`, which used to scan upward to 8909): a share
link is now `<reachable host>:<the runtime's own port>/share?session=<id>`. It also means the fallback
policy is uniform — the port falls back to a random one when 8787 is taken (another runtime, or a dev
server), so the share _base URL_ must always be read from `access:info` and never hard-coded. Sharing is
switched with `--no-share` / `MICA_DESKTOP_SHARE_PORT=0`, which only disables the `/share` route
(`--share-port <n>` is still accepted but treated as on/off, the number no longer means anything).

Everything on the port is the same runtime with the same state. Drawing one less panel in the share
view is **presentation, not access control** — a client there can still invoke every channel (see "There
is no authorization boundary"). The renderer decides it is in share view from `location.pathname`
(`isSharePath`) using the same pure helpers the router uses, not from an `/api/env` flag.

Static assets are referenced relatively (`./assets/x.js`) in the built `index.html`, so under
`/mica-web/` and `/share/` they resolve to prefixed URLs — the runtime strips the service prefix with
`toAssetPath()` before serving, which is why all three entry paths render the same bundle.

### How it is wired

- `POST /api/invoke` `{ channel, payload }` is the `ipcRenderer.invoke` equivalent; handlers run in
  the same process as the Electron main process would, so PTY terminals, resident `mica app-server`
  hosts, file/Git/stats/config access all behave identically.
- `GET /api/events` is a Server-Sent Events stream carrying every push channel
  (`terminal:data|exit`, `chat:event|exit|queue-state|queue-error|run-started|commit-exit`,
  `notify:changed`,
  `ui-state:changed`, `loops:changed`).
  Events are broadcast to every connected client, so a phone and a desktop tab share one state.
  The controlled-browser host adds `browser:changed` to the same stream (see _Controlled browser
  windows_ below).
- `GET /api/env` returns `platform` / `homeDir`; the renderer fetches it before mounting and
  installs `window.mica` (see `src/renderer/src/transport.js`).
- `GET /api/image?path=...` serves pasted and attached images, replacing the `file://` URLs that
  only resolve inside Electron.
- `MICA_DESKTOP_USER_DATA` (the container passes `app.getPath('userData')`) and the shim default
  resolve to the same `mica-code-app` directory, so `ui-state.json`, `file-order.json` and
  `session-pins.json`, `session-projects.json`, `session-sort.json` and `loops.json` are
  shared between the desktop app and a standalone runtime.

### Controlled browser windows

The container can hand the agent a real browser. It is the one capability that cannot live in
`src/host/`: only the Electron main process can create windows, so `src/main/browser/` owns a
tabbed, AI-driven browser and a small localhost HTTP API; the runtime only bridges it for the page.

- `src/main/browser/browser-host.js` is what `src/main/index.js` starts (`startBrowserHost()`): it
  builds the manager and brings up the API server on a **Unix socket** (`MICA_BROWSER_SOCKET`, under
  the app's `userData`), handed to the runtime through that variable — no TCP port of its own. The
  runtime forwards the socket as `/remote/control/*` on its single port and every `mica` child gets
  `MICA_BROWSER_URL` = that prefix.
- `browser-manager.js` holds the windows. Each browser is a `BrowserWindow` whose own webContents
  renders a display-only chrome bar (`browser-chrome.js`: tab strip, read-only URL, owner) with the
  page in a `WebContentsView` below it — tabs, navigation and input are the API's job, there is no
  address bar to type into. Closing the window hides it (`close` is intercepted) so the agent keeps
  its session; `POST /browser/browsers/:id/close` is the only way to really destroy it. Pages live
  in the isolated `persist:mica-browser` partition, `window.open` is redirected into a new tab
  instead of a popup, and permissions are denied outright.
- `browser-service.js` is the API (`/browser/capabilities`, `/browser/browsers`, `/browser/tabs`,
  `navigate|evaluate|content|click|type|keys|scroll|screenshot|wait|cookies|console|network`,
  `/browser/events`). Requests are JSON in/out, `x-mica-owner` (or `owner` in the body/query) says
  which mica session a window belongs to, and the server refuses anything that is not a local
  request (`Origin`/`Host` guard) so a random web page cannot drive it. `browser-docs.js` is the one
  place the endpoint catalog lives: the routes, `/browser/docs` and the MCP `control` tool's doc list
  all read it, and `browser-service.js` refuses to start if a documented endpoint has no handler.
- Screenshots go through CDP (`Page.captureScreenshot`) rather than `capturePage()` because a hidden
  window has no display surface. Input is the trade-off: native CDP events only reach a _visible_
  window, so `click`/`type`/`keys` fall back to in-page synthetic events while the window is hidden
  and report which path they used (`via`). `evaluate`, `content`, `wait`, `cookies`, `console`,
  `network` and `screenshot` work either way.
- Hidden windows are _occluded_ windows as far as Chromium is concerned, so its renderer freezes
  them: `requestAnimationFrame` never fires and `document.visibilityState` stays `hidden` (measured:
  0 rAF ticks in 4s). Anything that renders on rAF (charts, canvas, virtualized lists) and any SPA
  that pauses itself when hidden therefore stops advancing, and screenshots return the frame it froze
  on. `src/main/index.js` applies `--disable-backgrounding-occluded-windows` before `app.whenReady()`
  to turn that off — it is the only lever that works (a view-level `backgroundThrottling: false` only
  un-throttles timers, `Page.startScreencast` / `Emulation.setVirtualTimePolicy` /
  `disable-renderer-backgrounding` / `CalculateNativeWinOcclusion` all do nothing). It restores both
  rAF and `visibilityState: visible`. The cost is that hidden windows keep rendering, so it is on by
  default and can be turned off with `MICA_BROWSER_UNTHROTTLE=0` (it is a process-wide switch, not
  per-window).
- `src/host/browser-control.js` is the runtime side: it reads `MICA_BROWSER_URL`, keeps the window
  list fresh from `/browser/events`, broadcasts `browser:changed` and exposes the `browser-control:*`
  IPC channels (used by the top bar and by the settings page). The agent never calls the HTTP API
  directly: `src/host/control-mcp.js` serves a single-tool MCP endpoint at `/mcp/browser` (calling it
  without `action` returns the operation docs), and `src/host/control-mcp-config.js` writes a
  per-session `--mcp-config` file carrying `x-mica-owner`. A `mica-browser` / `mica-terminal` entry in
  `config.json` reaches the same endpoints from the TUI and `mica exec`; its url uses
  `http://127.0.0.1:${MICA_DESKTOP_PORT:-8787}/mcp/<kind>` so it follows the runtime port (the
  per-session file wins on name conflict). Without the socket — a standalone
  `npm run start:web` — everything degrades to "no browser service" and the icons never appear.
- The page (`App.jsx`) renders one icon per window of the active chat, immediately left of the
  terminal toggle: click toggles the native window, right-click (or a touch long press) destroys it
  after a confirmation, and the count badge distinguishes several windows of the same session.
  Browsers whose owner is unknown are shown dimmed rather than hidden, so a window opened by hand
  with `curl` is still manageable. The settings page has a _Browser Control_ section (its sidebar
  entry is always there; the data only exists inside the desktop runtime) that shows the service
  status, the MCP endpoint and tool name, and the whole endpoint catalog. The
  skill body itself is not shown — it is a single line (the service address), and copying the
  endpoint list into it would just drift; the agent fetches `/browser/docs` from the address. It
  deliberately does **not** manage windows — opening, showing, hiding and destroying a window is the
  agent's job (or the globe icon in the chat header); windows are created hidden so they never steal
  focus from what you are doing.

### Terminal control

The second main-process capability (`src/main/terminal/`) is a real terminal the agent can drive.
It is not a simulated shell: `node-pty` opens a real pty and the login shell (the same mechanism as
Terminal.app and VS Code), while `@xterm/headless` only mirrors that output into a screen buffer so
the agent can read what the terminal currently shows. `terminal-docs.js` is the single endpoint
catalog, and the runtime exposes it on its existing port as `/remote/terminal/*` (proxied to the
main process' Unix socket) so the agent only needs `MICA_TERMINAL_URL`.

- `terminal-sessions.js` owns the PTYs (max 12 live shells; exited ones do not take a slot). Output
  is buffered (256k chars, with a `seq` for reconnect/replay) and parsed by a headless xterm; reading
  the screen waits for queued writes to finish, otherwise a command that just ran looks like it
  printed nothing. A periodic `sweep()` cleans up after agents: an exited session goes 10 minutes
  after its last look, a live one only once it has been hidden and completely idle (no output, input
  or resize) for 6 hours, so a shell that is still doing something is never killed. Sessions with a
  visible window are always kept. Closing a session, from the endpoint or from `sweep()`, destroys
  its window through the same `closed` event.
- `terminal-window.js` creates a `BrowserWindow` on demand: a session created without `show` has no
  renderer at all, which keeps agent-only terminals cheap. Closing the window only hides — the PTY
  keeps running — and the explicit `close` endpoint kills the process. The window loads the
  runtime-served page `/terminal-control?session=<id>`, so page and agent share the same PTY through
  HTTP + SSE; there is no preload and no extra IPC surface in the shell.
- The page (`src/renderer/src/terminal-page.jsx`, a second Vite entry) renders with xterm's DOM
  renderer, not canvas. PTY size is the source of truth: an agent resize is applied to the page,
  while resizing the native window fits and reports the new size back. A hidden window only records
  that it fell behind and rebuilds from a snapshot when shown, instead of parsing every frame in the
  background.
- The agent flow is create → `input` (text + submit) → `wait` → read the session's
  `screen`/`inputLine`. `wait` matches text/regex after masking the echo of what was just typed
  (only the first hit per input, so identical output still matches; `skipEcho: false` disables it),
  and `expectExitCode` is the reliable way to tell whether a command succeeded. Writes carry
  `x-mica-owner`: an agent cannot type into or close another chat's terminal, while the human page
  (no owner header) can still take over any of them. The top-bar shows one icon **per live terminal
  of the current chat** (numbered when there are several) and nothing at all when the chat has none;
  icons toggle the window, right-click closes it after a confirmation. Creating a session is the
  agent's job (`POST /sessions`), the same split as the browser icons.
- `src/host/terminal-control.js` mirrors the browser bridge: it subscribes to `/terminal/events`,
  forwards `terminal:changed` only to pages watching that session (plus list subscribers), exposes
  `terminal-control:*` IPC. The agent uses it through the `/mcp/terminal` MCP endpoint (same
  single-tool bridge as the browser). A standalone `npm run start:web` has no main process, so
  `/remote/terminal/*` answers 503 instead of falling back to the SPA.
- The settings page has a _Terminal Control_ section next to _Browser Control_ (the sidebar entry is
  always there; only the desktop runtime can read the data). It shows the service address and
  version, the MCP endpoint, every live session (title, cwd, size, running/exited, window in
  the foreground or not) and the full endpoint catalog with copyable `curl` examples. Like the
  browser section it does **not** create or close sessions: that is the agent's job, and buttons
  would suggest you have to build them by hand.

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
keyed by _key + value_ and claims every broadcast (`claimUiStateEcho`) — comparing against "the
last value I wrote" is not enough; and the draft table must not be read through React rendering in
`App.jsx` (that would re-render the whole sidebar on every keystroke), which is why the sidebar
markers go through `subscribeUiState` and the reference-stable `draftMarkers`.

Scheduled loops are host-owned state that is deliberately _not_ UI state: they outlive the page, so they are persisted to `userData/loops.json` and scheduled by the runtime (`loops.js`) instead of being rebuilt from a page-side `setInterval` — see the 定时任务 paragraph above. The composer panel writes and reads intervals through the same `packages/mica-common/loopArgs.ts` helpers the CLI's `/loop` uses (`formatLoopInterval`, `MIN_LOOP_INTERVAL_MS`/`MAX_LOOP_INTERVAL_MS`), so both ends accept the same wording and nobody re-implements the parsing.

Right-side panel terminals are the one piece still owned per page: the PTYs live in the runtime and
their output is broadcast to everyone, but creating, respawning (`staleRightTermIds`) and reclaiming
them are single-writer operations that would fight each other from two pages, so sharing that list
needs an owner rule first.

### URL state and share links

The open session is mirrored into the address bar (`src/renderer/src/app-url.js`, pure logic with
unit tests): every switch `replaceState`s `?session=<id>` (replace, not push, so the back button
still leaves the app; unrelated params such as `?layout=` are preserved), and on boot the page opens
the session named by `?session=` — once the session list has loaded, so the tab gets its title and
working directory. An id that no longer exists still opens, letting the chat side report the failure
instead of doing nothing at all.

The write-back waits until a session is actually open (`urlSessionRef.current`), so the first frame cannot
clobber the param with an empty session and leave the page showing nothing.

#### There is no authorization boundary

The runtime has no accounts and no access control beyond two things that do not restrict normal use:

- A request carrying `Origin` must be same-site, and `Host` must be a name this machine actually answers
  on — which is what stops an arbitrary web page from quietly talking to `http://127.0.0.1:8787` on the
  visitor's behalf. Same-site ignores the port, because the dev server serves the page on
  `localhost:5173` and proxies `/api` to the runtime.
- The host allowlist is the loopback names, this machine's hostname and its interface addresses, plus
  whatever `MICA_DESKTOP_ALLOWED_HOSTS` (comma-separated, names or IPs) adds. That variable is the
  escape hatch for reaching the runtime under a name it does not own — a reverse tunnel or a proxy,
  where the browser keeps sending the _public_ address as `Host` while the runtime only sees the
  loopback connection. Without it such a request answers `403 Host 不被允许`: the static shell and
  `/api/health` still load (health is deliberately credential-free), so the page renders its "无法连接
  Mica Code 运行时" screen even though the tunnel is fine. It is read once per process — restart the app
  after changing it.

`src/host/access-core.js` holds these two judgements as pure logic with unit tests;
`src/host/access.js` wires them up and computes the reachable base URL; `src/server/index.js` runs them
on every request. There is no token, no cookie and no per-session visitor scope: **every client is a
full client.** Connecting to the port is equivalent to having a shell on the host — the terminal is a
real shell, files are read/write, and the config page holds your API keys. The default `0.0.0.0` bind is
a product decision (a phone on the LAN can drive the agent), so keep the warning in this file honest.

#### A share link

`分享链接` builds the address of one session: the session row's context menu (`session-menu.js`; drafts
have no session id yet, so they do not offer it) and the chat area's context menu both copy it
straight to the clipboard and report the result in a one-line toast at the bottom of the window — no
dialog to click through. Copying goes through `copyText`, which says so honestly when the clipboard
API is unavailable (plain http on the LAN is not a secure context) instead of claiming success.

The link is `<reachable base>/share?session=<id>` (`app-url.js`'s `sessionShareUrl`) — no token, no
fragment; opening it is the same as clicking that session in the list. The base URL comes from the
_runtime_, never from the page's own `location.origin`: a window on the machine is served from
`127.0.0.1`, and handing that to someone else points at their own machine. `pickShareBaseUrl` prefers
`MICA_DESKTOP_PUBLIC_URL` (a bare domain gets `/share` appended), then the address the sharer is
already using, then the machine's interface addresses (private LAN first) — and always pins the
**runtime's own port** plus the `/share` path (read from `access:info`; the port falls back to a random
one when 8787 is taken), because the share surface is a path on the one listener, not a second one.
When sharing is off (`--no-share`) the dialog reports that sharing is unavailable.

Copying a link also records the session in the share list (`src/host/shared-sessions.js` +
`shared-sessions-core.js`, persisted to `userData/shared-sessions.json`), so `/share` itself (the
`ShareIndex` component, rendered by `main.jsx` when `/api/env` says `share: true` and no
`?session=` is present) can list what has been handed out: title, working directory, when it was
shared, a copy button, an open button and a remove button. That page is the only way to navigate there,
since the share surface has no session list; a session that no longer exists stays in the list marked
`会话已不存在` until it is removed.

What the link hides is only the session list: **treat it as lending someone this machine** — the holder
can chat, interrupt, queue, compact, change the working directory, browse files, open a shell in the
terminal panel and read the config page (and can reach the same channels by hand regardless of what the
page draws). It never expires and there is no revocation list — taking it back means stopping the
runtime or moving to another port.

#### One session, one tab, one set of terminals

The workspace lives in the runtime and is shared by every page, so the second window is another viewport
of the same UI rather than a separate place: events are broadcast to all clients, both render the same
live turn, and both can queue, recall or interrupt it. Two tabs for one session would fight each other,
so `workspace.js`'s `dedupeSessionNodes` (pure function with unit tests) merges duplicates by
`sessionId` when the workspace is read, and `App.jsx` converges once more against the notify state
(`prefer: isRunning`, keeping the tab whose turn is actually running — turn events are dispatched by
node id, so only that one receives them). Without it the later tab gets `isChatSessionRunning` and is
told "正在另一个进程里运行"; `chat:is-running`'s `remoteRunning` therefore only ever means a **turn
lease** held by another process (a TUI in a terminal, `mica exec`, a second runtime instance).

Terminals are shared the same way. The PTY lives in the runtime and its output is broadcast over SSE,
and the panel inventory (which terminals exist per session, which one is active) is part of the shared
UI state (`rightTerms`). PTY ids are derived from the tab id (`TerminalHost.ptyIdFor`), so both pages
compute the same id; a page attaching to an existing terminal gets `{ reused: true }` plus a `replay`
of the host-side output tail, which it writes into its xterm so the panel is not blank.

### Switching Mica servers

A window can point at another machine's Mica runtime: hovering the sidebar's `Server` row floats a card next to it (`ServerCard.jsx`) with the current server, the servers you have connected to, the `本机` way back and an address field — the card is deliberately not a modal, so nothing blocks the rest of the UI. On a touch screen there is no hover, so tapping the row expands the same card in place inside the drawer. A page is served by whichever runtime hosts it, so "which server am I on" is just `location.origin` — nothing is proxied and no cross-origin call is made.

Switching opens that address in **a new window** (desktop app) or **a new tab** (browser), so the server you are on keeps its own window instead of being replaced. `renderer/src/servers.js` picks the branch by user agent (`isElectronShell`): inside the container it hands the navigation to the shell (`location.assign`, intercepted by `will-navigate`), anywhere else it calls `window.open(url, '_blank')` and severs `window.opener` afterwards — deliberately not the `noopener` feature string, which makes `window.open` return `null` and would hide a blocked popup — falling back to the current tab when the popup _is_ blocked.

The one thing the page cannot do itself is delegated to the runtime (`src/host/servers.js`, pure logic in `servers-core.js`): probing `GET /api/health` on the target, because a cross-origin `fetch` from the page is unreadable under CORS. Everything else is page-side: a successful probe is recorded by `servers.js` in `localStorage` (key `mica-servers`, newest first, eight entries max, deduplicated by host) and rendered as rows in the same style as the current server, so getting back to a machine is a click instead of retyping its address. Each entry is `{ url, note }` (legacy address-only arrays are still read) and the note is editable in place from the row — a hover-revealed pencil, saved on Enter or blur, cancelled with Esc — because `192.168.1.5` and `192.168.1.6` look alike; there is still no manual add/remove, so the list only ever holds addresses that answered as a Mica Code runtime, and it follows the page's origin, so a window on another machine has its own list. The `本机` entry is the fixed loopback-on-the-default-port shortcut (`LOCAL_SERVER_URL`, built from `DEFAULT_RUNTIME_PORT`), only offered while the page is hosted by a non-loopback runtime (when it is, you are already home); the current server and that shortcut never appear twice in the list.

The container owns the navigation policy and one window per server (`src/main/index.js`). `will-navigate` lets a window's own origin (and the local page) navigate in place, hands the navigation to the window that already shows that server (focused, not reloaded), otherwise opens a new window when `/api/health` of the target reports `app: 'mica-code-app'`, and sends everything else to the system browser. Each window keeps its own state — `did-navigate` re-points that window's unread-badge subscription at the origin it shows and appends `— host:port` to its title, and the dock badge reflects the focused window. The first window is the local one and closing it only hides it; windows opened for other machines close for real. The app always starts on the local runtime (there is no "last server" record to restore). Because the server you switch to may be running an older bundle with no switcher of its own, **⇧⌘M** (shell level, `before-input-event`) always brings the local window to the front (loading it into the current window if it is gone), and the boot-error page offers 返回本机 whenever the current origin is not loopback — that click reloads the local page rather than focusing a window when the error page _is_ the local window, so it stays a recovery action.

### What the page does differently from a native app

- **Folder pickers become in-app.** `dialog:select-directory` has no browser equivalent, so
  `CwdModal` opens `DirectoryPicker`, which browses the _server's_ filesystem through `files:list`.
- **Clipboard writes happen in the browser.** `files.copyPath` / `copyRelativePath` copy locally via
  `navigator.clipboard` with an `execCommand` fallback (a plain-HTTP LAN page is not a secure
  context). `files.reveal` still opens the containing folder on the server machine.
- **External links open in the browser tab**, not on the server.
- **Terminal file links open the in-app editor** instead of VS Code: the transport dispatches a
  `mica:open-file` event that `App.jsx` routes to the Files view.
- **Settings is inlined, not framed.** The view renders the config page components from
  `packages/mica-config-ui` directly and gets its data through `config-web:invoke`
  (`src/host/configWebData.js`, which reads this machine's `$MICA_HOME`). Nothing is spawned and no
  iframe is used, so the page always configures the runtime that serves it — switching to another
  server configures _that_ machine. The Roles section shows the built-in `default` role read-only
  with its actual prompt: the host reads `packages/mica-agent/prompt/system.md` (brand placeholders
  expanded, `?raw` import) instead of keeping a second copy of the prompt, and a `default.md` in
  `~/.mica/role` cannot shadow or duplicate it.
- **Window focus/visibility comes from the page**: `document.visibilityState` plus `focus`/`blur`.
- **Row drag & drop is plain HTML5 DnD.** Section changes go through one `stats:move-session`
  call rather than a client-side list juggling act, which is also why the sidebar in two browser
  tabs (or on a phone) converges instead of each client keeping its own copy of the sections.

### Mobile layout

Below 768px the two-column shell collapses to a single column: the session list becomes an overlay
drawer (scrim + close button), the Files view swaps between the tree and the editor behind a back
button, and right-click-only actions gain long-press equivalents on touch
(`longPressHandlers` ignores mouse pointers, so desktop behaviour is unchanged). `?layout=mobile`
and `?layout=desktop` force a layout for previewing on a large screen.

The mobile block in `assets/app.css` also floors every form control at `16px`. iOS Safari zooms the
whole page when a control with a smaller computed font size takes focus, and it does not zoom back
out on blur — the page stays magnified after leaving the composer. The rule is scoped as
`#root input, #root select, #root textarea:not(.inputarea)` so it outranks Tailwind's per-component
`text-[13px]` utilities, and it exempts monaco's hidden `inputarea` textarea (the editor measures
and positions IME candidates off that element). The composer action buttons grow to 32px at the same
breakpoint because 25px is below a comfortable touch target.

The terminal panel gets a `TerminalKeyBar` below 768px, under the terminal: a soft keyboard has no
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
