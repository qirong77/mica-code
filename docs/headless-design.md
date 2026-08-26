# Mica headless design (Codex-aligned)

Mica runs a UI-agnostic headless execution core that speaks the OpenAI Codex
protocol family, so any client that already drives `codex exec` or
`codex app-server` can drive Mica without a Mica-specific adapter. This doc
covers the *internal design* of that headless layer; integration and
registration steps live in [multica-runtime.md](./multica-runtime.md).

## Design goal

Three surfaces share one turn-execution core, and they must behave **the same
way** (single-slot queue, iteration-boundary injection, turn-level retry,
abort, plugin hooks, session persistence):

| Surface                    | Entry point                          | Transport                        |
| -------------------------- | ------------------------------------ | -------------------------------- |
| One-shot                   | `mica exec [--json] "<prompt>"`      | stdout text or Codex ThreadEvent |
| Resident per-session host  | `mica app-server`                    | Codex v2 JSON-RPC over stdio    |
| Sync daemon command host   | `CommandExecutor`                    | Codex v2 JSON-RPC over stdio    |

All three build the same `HeadlessTurnExecutor` and attach the same
`HeadlessPluginHost`; the only differences are the output protocol and how
stdin/input arrives.

## Core: HeadlessTurnExecutor

`apps/cli/src/runtime/HeadlessTurnExecutor.ts` is the UI-agnostic turn loop. It
owns the message queue and turn lifecycle, and never touches Ink/UI or an output
protocol — streamed text/tool/usage events are surfaced on the consumer side
(`CodexProjector`, sync-event mapping, or the last text result).

Key behaviors that mirror the interactive `LocalRuntimeController`:

- **Single-slot queue** (one turn runs at a time). While busy, new inputs
  enqueue; `after_iteration` inputs are injected at a completed tool iteration
  boundary, `after_turn` inputs start once the current turn ends.
- **Queue semantics** are owner-aware and single-slot; `turn/start` when a turn
  is active is rejected with a JSON-RPC error telling the client to use
  `turn/steer`.
- **Turn-level retry** (see `MAX_TURN_RETRIES` / `TURN_RETRY_DELAY_MS`): up to
  5 attempts, 10s fixed delay, only for transient provider errors
  (`micaAgent.isRetryableError`), and **never after a non-readonly tool call**
  ran (`micaTools.isReadOnly`), so a retry cannot re-run a side-effecting tool.
  Before each retry it restores the pre-turn client snapshot and clears partial
  output; aborted input consumed by a failed attempt is re-injected at the next
  attempt's first iteration boundary so a retry never swallows a queued input.
- **Abort** stops the active turn but keeps the queue draining. An abort that
  lands between `reserveRunId()` and the first `agent.run()` is surfaced as an
  `AgentAbortError` and never retried; it is mapped to an `interrupted` turn
  completion.
- **Events** are reported through `onEvent` (`turn:start`, `turn:retrying`,
  `turn:finish`, `queued`, `dequeue`, `queue:changed`). `turn:finish` is always
  emitted with one of `completed` / `aborted` / `error`.
- **Session persistence** saves a `running` checkpoint before the turn, a
  completed save after success, and `aborted`/`error` saves on failure.
  `save: false` (`--no-save`) skips persistence for one-shot tasks.

## Headless plugin layer

`apps/cli/src/headless/HeadlessPluginHost.ts` runs the **same built-in plugins**
as the interactive app, minus the inherently terminal-bound ones (file-mention,
the `/model` / `/compact` command suite, user file plugins). The agent-shaping
plugins — `session_*` autonomy, context-pressure red-zone reminder, message
queueing, command-memory guide, TodoWrite, app-notify — behave identically.

Differences are deliberate and documented:

- **MCP** stays hand-managed by each headless entry point (`--mcp-config` /
  `--strict-mcp-config` / `--mcp-init-timeout-ms`), because headless does not
  want to force the interactive MCP lifecycle.
- `attachPluginLayer()` swaps the executor's queue to the plugin host's shared
  single-slot queue. Without this swap a plugin-enqueued input would land in a
  second queue and be stranded on dequeue, so the two must share one queue.
- The plugin host publishes `context:changed` as an event (not a UI store), so
  context-pressure works with no Ink dependency.

## Codex exec transport (`mica exec`)

`apps/cli/src/cli/runExec.ts` is the one-shot path. Default output is
human-readable text on stdout; `--json` switches to Codex `ThreadEvent` JSONL
(`thread.started`, `turn.started`, `item.started`/`updated`/`completed`,
`turn.completed`, `error`; item types `agent_message` / `reasoning` /
`command_execution`). It mirrors `codex exec --json` so existing consumers parse
it unchanged.

Event shapes live in `packages/mica-runtime/codexExecEvents.ts`; the writer is
`createStdoutCodexExecWriter`. `CodexExecProjector`
(`apps/cli/src/runtime/CodexExecProjector.ts`) maps agent events to those
shapes. `--thinking` adds `reasoning` items; private reasoning is never mixed
into final text.

`runExec` resolves the model before the runtime loads and degrades cleanly:
a missing resume target fails before any turn event with a single `error` line
(no stale session echo); `--no-save` skips session persistence; an aborted run
exits `130`, success `0`, failure `1`.

## Codex app-server transport (`mica app-server`)

`apps/cli/src/cli/runAppServer.ts` is the **resident per-session process**. It
holds the AgentRuntime, MCP connections, and the shared `HeadlessTurnExecutor`
for the whole session lifetime, so repeated turns skip process startup, session
reload, and MCP re-init.

- **Framing**: one JSON object per line over stdio, no `jsonrpc` field
  (`packages/mica-runtime/codexProtocol.ts`). Requests get `id`+`result` /
  `id`+`error`; notifications are fire-and-forget with an `emittedAtMs`.
- **Implemented methods** (`CODEX_METHODS`): `initialize`, `initialized`,
  `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt`.
  Unknown methods return `-32601 method-not-found` so clients can negotiate.
- **Notifications** (`CODEX_NOTIFICATIONS`): `thread/started`,
  `turn/started`, `turn/completed`, `item/started`, `item/completed`,
  `item/agentMessage/delta`, `item/reasoning/textDelta`,
  `item/commandExecution/outputDelta`, `thread/tokenUsage/updated`, `error`,
  `warning`.
- **Transport flags**: `mica app-server` accepts and drops Codex transport
  flags `--listen <v>` / `--listen=<v>` / `--stdio` (`apps/cli/src/cli/args.ts`
  `app-server` branch), because Mica's app-server is always stdio. Drivers that
  spawn `app-server --listen stdio://` (Multica does) are accepted.
- **Model routing**: the driver-selected model is honored on `thread/start`,
  `thread/resume`, **and** `turn/start` — each resolves `params.model` /
  `params.effort` with `resolveRuntimeConfigOverride` (longest configured
  provider prefix wins, so `krill/gpt-5.6-terra` routes to the `krill`
  provider). This matters because Multica conveys the agent model via
  `thread/start` (/`thread/resume`) rather than a launch flag, and does not send
  `model` on `turn/start`. Priority is `params.model` → CLI `--model/--variant`
  → persisted session snapshot.
- **Startup resilience**: a stale/deleted `--dir` does not kill the host (writes
  an `error` notification and keeps serving); a failed `--session` resume
  degrades to a fresh session with the real reason surfaced; MCP init failures
  degrade to host-without-MCP-tools rather than `exit(1)`. The host installs
  `unhandledRejection` (log + notify, keep serving) and `uncaughtException`
  (notify then exit) handlers so it never dies silently with a bare code 1.
- **Lifecycle**: `turn/steer` maps to the executor's `after_iteration` queue
  (iteration-boundary injection, matching Shift+Tab in the app); `turn/start`
  starts a fresh turn when idle; `turn/interrupt` aborts the active turn. The
  host exits when stdin closes or on SIGINT/SIGTERM/SIGHUP, flushing stdout and
  stderr before `exit(code)` so the client sees the real reason.

## Mica extension notifications

The Codex protocol has no events for queue state, long-lived background tasks,
or a replaced session history. Mica adds these as **incremental extensions**
(unknown notification methods are ignored by Codex clients):

- `mica/queue/{queued,dequeue,changed}` (`MICA_QUEUE_NOTIFICATIONS`): drive
  queue state so a client learns a `turn/steer` input is waiting at the host for
  its iteration boundary.
- `mica/backgroundTasks/updated`, `mica/subagentTasks/updated`
  (`MICA_TASK_NOTIFICATIONS`): snapshot pushes of long-lived host state that
  outlives a turn (background `run_shell` tasks, running subagents including
  `run_in_background`). The host emits only when the serialized snapshot changed
  and pushes a replacement whole list.
- `mica/sessionHistory/replaced` (`MICA_SESSION_NOTIFICATIONS`): the
  `session_compact` tool replaced the persisted history mid-host; the client
  reloads the session instead of showing a stale transcript.

## Model, effort, and context resolution

- `mica models` prints one `<provider-id>/<model-id>` per line (line-delimited),
  or `--json` for `[{id, efforts}]`.
- Model rule metadata (vision, context window, effort options) is ensured before
  the runtime loads via `ensureChatHostModelRule` / `ensureHeadlessModelRule`.
  Headless mode logs a missing metadata error to **stderr** and falls back to the
  generic rule — it never pollutes protocol stdout.
- A daemon-selected model/effort is a session-local override and does not change
  Mica's persisted last-used preference (`SessionController` config `apply()`
  is a no-op in headless mode). `--model`/`--variant` are merged by
  `resolveRuntimeConfigOverride` and take priority over the session snapshot on
  resume.

## Workspace, instructions, and skills

`--dir` is applied before model/runtime modules load. Task runners write task
context into that directory. Mica loads both `AGENT.md` and `AGENTS.md` and
scans these project skill roots: `.mica/skills`, `.agents/skills`,
`.deveco/skills`, `.agent_context/skills`. It continues to load user skills from
`$MICA_HOME/skills` (or `~/.mica/skills`); when `MICA_HOME` is unset it also
recognizes `~/.config/deveco/skills`.

## Current limits

- `mica exec --json` has no reasoning event by default; pass `--thinking` to
  project `reasoning` items.
- Mica runs tools autonomously; `--dangerously-skip-permissions` acknowledges
  the daemon policy but does not switch a separate permission engine. The
  app-server advertises `approvalPolicy=never` / `sandboxPolicy=dangerFullAccess`
  and warns when a client requests a different policy it cannot enforce.
- `codex exec` flags not implemented: `--sandbox <mode>`, `--full-auto`,
  `-o/--output-last-message`. Naming difference: Mica uses `--variant <effort>`
  for reasoning effort (Codex uses `--effort`), and stdin prompt via `-` is not
  supported (only a positional prompt).
- `app-server` protocol subset is intentionally small; `thread/fork`,
  `thread/list`, `command/exec`, `fs/*`, `model/list`, `plugin/list` are not
  implemented and return `method-not-found`.
