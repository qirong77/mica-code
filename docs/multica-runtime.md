# Multica runtime compatibility

Mica can run as a Multica custom runtime through Multica's existing `deveco`
protocol family. That family uses the OpenCode/DevEco process contract:

```text
<agent> --version
<agent> models
<agent> run --format json --dangerously-skip-permissions \
  --dir <workdir> [--model <provider/model>] [--variant <effort>] \
  [--session <id>] <prompt>
```

The run command emits one JSON object per stdout line. Mica keeps diagnostics on
stderr and uses exit code `0` for success, `1` for failure, and `130` for an
interrupted run.

## Register in Multica

If the release binary is available as `mica-code` on the daemon host:

```bash
multica runtime profile create \
  --protocol-family deveco \
  --command-name mica-code \
  --display-name "Mica Code"
```

If it is not on the daemon's `PATH`, pin the profile to the absolute binary:

```bash
multica runtime profile set-path <profile-id> --path /absolute/path/to/mica-code
```

Restart or refresh the Multica daemon after creating or changing the profile.
The local development build is normally named `mica`; either executable name is
valid as long as the selected path points to the updated binary.

## Protocol layers

There are several protocols in the combined system. They should not be treated
as interchangeable merely because more than one uses newline-delimited JSON.

| Layer                        | Owner                                                                                       | Mica responsibility                             |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Multica daemon control plane | Multica HTTP/WebSocket registration, heartbeat, claim, and reporting                        | None; the daemon owns it                        |
| DevEco/OpenCode run JSON     | `run --format json`, positional prompt, stdout NDJSON                                       | Supported; this is the integration transport    |
| Claude SDK stream-json       | Bidirectional stdin/stdout with `system`, `assistant`, `user`, `result`, and control frames | Not supported; do not register Mica as `claude` |
| Codex app-server             | JSON-RPC thread/turn protocol                                                               | Not supported                                   |
| ACP                          | JSON-RPC `initialize` and `session/*` methods                                               | Not currently supported                         |
| MCP                          | Mica tool-server connections over stdio or Streamable HTTP                                  | Supported inside Mica                           |

The Claude Code source is useful as a design reference for strict stdout,
session-first startup, cancellation, usage aggregation, and long-running tool
handling. Its `stream-json` schema is nevertheless a different wire protocol.

## Run JSON events

Mica emits the event shapes consumed by Multica's DevEco backend:

- `step_start` announces a running session.
- `text` streams assistant output from `part.text`.
- `tool_use` contains a completed call and result under `part.state`.
- `error` carries `error.name` and `error.data.message`.
- `step_finish` carries aggregate input, output, and cache token usage.

Every event after session creation includes the camel-case `sessionID` field
expected by that backend. A missing resume target fails before `step_start` and
does not echo the stale session ID, allowing Multica to retry with a fresh
session.

The DevEco parser has no distinct tool-start/tool-progress frame: emitting a
running and then a completed `tool_use` would duplicate the call in Multica and
leave its in-flight counter unbalanced. Mica therefore emits one terminal tool
event and intentionally does not send synthetic heartbeats that could hide a
genuinely stuck tool from Multica's inactivity watchdog.

## Models, working directory, instructions, and skills

`mica models` prints one model ID per line as `<provider-id>/<model-id>`. On a
run, Mica resolves the longest configured provider prefix, so model IDs that
themselves contain `/` remain intact. A daemon-selected model and effort are
session-local overrides and do not change Mica's persisted last-used choice.

The `--dir` value is applied before model/runtime modules load. This matters
because Multica writes task context into that directory. Mica loads both
`AGENT.md` and `AGENTS.md` and scans these project skill roots:

- `.mica/skills`
- `.agents/skills`
- `.deveco/skills`
- `.agent_context/skills`

It continues to load user skills from `$MICA_HOME/skills` (or
`~/.mica/skills`). When `MICA_HOME` is not set, it also recognizes the DevEco
family's user-level `~/.config/deveco/skills` directory.

## MCP and current limits

Headless runs now initialize and shut down Mica's MCP connections. By default
they read `mcpServers` from Mica's own config. They can also accept:

```bash
mica run --format json \
  --mcp-config /path/to/mcp.json \
  --strict-mcp-config \
  "task"
```

Without strict mode, explicit servers override same-named local servers. Strict
mode uses only the explicit file.

Multica's current `deveco` backend does not forward an agent's managed
`mcp_config` to the child process. That is a Multica-side limitation: Mica's
explicit-file support is ready, but managed MCP will not arrive automatically
through this protocol family until Multica adds the corresponding argument or a
native Mica/ACP backend.

Other current limits:

- Multica's current DevEco `step_start` handler drops the event's `sessionID`
  when constructing its status message. Normal completion and later resume work,
  but a daemon/process crash before the final result can lose the early resume
  pointer. Fixing early session pinning requires Multica to copy `sessionID`
  onto that status message.
- DevEco run JSON has no thinking event consumed by Multica, so Mica does not
  mix private reasoning into final text.
- The same parser has no non-duplicating tool-start frame. Until Multica adds
  one, a running Mica tool is governed by the ordinary idle watchdog rather
  than Multica's longer in-flight-tool watchdog; unusually long tools may need
  a larger daemon idle window.
- Mica currently runs tools autonomously; the
  `--dangerously-skip-permissions` flag acknowledges the daemon policy but does
  not switch a separate permission engine.
- Claude plugins and Claude SDK control requests are not part of this adapter.
