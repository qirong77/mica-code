# Multica runtime compatibility

Mica exposes its execution surface with the OpenAI Codex protocol family, so any
client that already drives `codex exec` or `codex app-server` can drive Mica:

```text
<agent> --version
<agent> models
<agent> exec [--json] --dangerously-skip-permissions \
  --dir <workdir> [--model <provider/model>] [--variant <effort>] \
  [--session <id>] <prompt>
<agent> app-server [--session <id>] [--dir <workdir>]
```

`mica exec` mirrors `codex exec`: default human-readable text on stdout, and with
`--json` it emits Codex ThreadEvent JSONL (`thread.started`, `turn.started`,
`item.started`/`item.updated`/`item.completed`, `turn.completed`, `error`; item
types `agent_message`/`reasoning`/`command_execution`). `mica app-server` mirrors
`codex app-server --stdio`: JSON-RPC-style requests over stdin
(`initialize`/`thread/start`/`turn/start`/`turn/steer`/`turn/interrupt`) and v2
notifications over stdout. Mica keeps diagnostics on stderr and uses exit code
`0` for success, `1` for failure, and `130` for an interrupted run.

Codex-family drivers that spawn `app-server --listen stdio://` (Multica does this)
are also accepted: `mica app-server` recognizes and ignores the `--listen`
/ `--stdio` transport flags, since Mica's app-server always speaks stdio.

The driver-selected model is honored on both `thread/start` and `thread/resume`:
their `model` field is resolved like `turn/start` (longest configured provider
prefix wins, so a `krill/gpt-5.6-terra` id routes to the `krill` provider). This
matters because Multica conveys the agent model via `thread/start` (or
`thread/resume`) rather than a launch flag, so `--model` is optional.

## Register in Multica

If the release binary is available as `mica` on the daemon host:

```bash
multica runtime profile create \
  --command-name mica \
  --display-name "Mica Code"
```

If it is not on the daemon's `PATH`, pin the profile to the absolute binary:

```bash
multica runtime profile set-path <profile-id> --path /absolute/path/to/mica
```

Restart or refresh the Multica daemon after creating or changing the profile.
The local development build and release installer both default to the `mica`
command name; either absolute path or PATH lookup is fine as long as it points
to the updated binary.

## Protocol layers

There are several protocols in the combined system. They should not be treated
as interchangeable merely because more than one uses newline-delimited JSON.

| Layer                        | Owner                                                                                       | Mica responsibility                             |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Multica daemon control plane | Multica HTTP/WebSocket registration, heartbeat, claim, and reporting                        | None; the daemon owns it                        |
| Codex exec ThreadEvent       | `exec --json`, positional prompt, stdout JSONL                                              | Supported; this is the one-shot transport       |
| Codex app-server             | `app-server`, JSON-RPC thread/turn protocol over stdio                                      | Supported; this is the resident transport       |
| Claude SDK stream-json       | Bidirectional stdin/stdout with `system`, `assistant`, `user`, `result`, and control frames | Not supported; do not register Mica as `claude` |
| ACP                          | JSON-RPC `initialize` and `session/*` methods                                               | Not currently supported                         |
| MCP                          | Mica tool-server connections over stdio or Streamable HTTP                                  | Supported inside Mica                           |

The Claude Code source is useful as a design reference for strict stdout,
session-first startup, cancellation, usage aggregation, and long-running tool
handling. Its `stream-json` schema is nevertheless a different wire protocol.

## ThreadEvent events

`mica exec --json` emits the event shapes consumed by Codex-compatible backends:

- `thread.started` announces the thread id.
- `turn.started` opens a turn.
- `item.started` announces a running item (`command_execution` with
  `status: "in_progress"`).
- `item.updated` streams `agent_message` text and (with `--thinking`) `reasoning`.
- `item.completed` closes an item; a tool call carries `exit_code` and aggregated
  output, the final assistant message carries the full text.
- `turn.completed` carries aggregate input, output, cache, and reasoning tokens.
- `error` carries a message; a missing resume target fails before
  `thread.started` with a single `error` line.

A missing resume target fails before any turn event and does not echo the stale
session ID, allowing callers to retry with a fresh session.

## Models, working directory, instructions, and skills

`mica models` prints one model ID per line as `<provider-id>/<model-id>`. On a
run, Mica resolves the longest configured provider prefix, so model IDs that
themselves contain `/` remain intact. A daemon-selected model and effort are
session-local overrides and do not change Mica's persisted last-used choice.

The `--dir` value is applied before model/runtime modules load. This matters
because task runners write task context into that directory. Mica loads both
`AGENT.md` and `AGENTS.md` and scans these project skill roots:

- `.mica/skills`
- `.agents/skills`
- `.deveco/skills`
- `.agent_context/skills`

It continues to load user skills from `$MICA_HOME/skills` (or
`~/.mica/skills`). When `MICA_HOME` is not set, it also recognizes the
`~/.config/deveco/skills` directory.

## MCP and current limits

Headless runs initialize and shut down Mica's MCP connections. By default they
read `mcpServers` from Mica's own config. They can also accept:

```bash
mica exec --json \
  --mcp-config /path/to/mcp.json \
  --strict-mcp-config \
  "task"
```

Without strict mode, explicit servers override same-named local servers. Strict
mode uses only the explicit file.

Other current limits:

- `mica exec --json` has no thinking event by default; pass `--thinking` to
  project `reasoning` items. Private reasoning is never mixed into final text.
- Mica currently runs tools autonomously; the
  `--dangerously-skip-permissions` flag acknowledges the daemon policy but does
  not switch a separate permission engine.
- Claude plugins and Claude SDK control requests are not part of this adapter.
