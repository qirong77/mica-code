# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `bun run dev` — Run in development mode (executes TS directly)
- `bun run build` — Build bundle with `bun build` (not compile)
- `bun run build:compile` — Build native binary via `bun build --compile` (see `scripts/build.mjs`)
- `bun test` — Run tests with vitest
- `bun run format` — Format all files with prettier
- `bun run format:check` — Check formatting

## Architecture Overview

Mica is a lightweight, plugin-based code agent CLI using **Bun** + **TypeScript** + **React** (custom fork of Ink at `packages/ink/`, imported as `@anthropic/ink`) + **Anthropic SDK**.

### Project Structure

```
src/
├── index.ts              # Entry: registers plugins, calls MicaAgent.run()
├── bootstrap.ts          # Wires TerminalInput.onSubmit → agentTurn.run()
├── core/
│   ├── agent.ts          # MicaAgent singleton: plugin registration, atom injection, UI access
│   └── agentEvents.ts    # Maps agentTurn event stream to nanostores
├── agent/
│   ├── turn.ts           # AgentTurn: middleware chain → Anthropic API → parallel tool exec → loop
│   └── client.ts         # Singleton Anthropic SDK client
├── plugins/
│   ├── MicaPlugin.ts     # Abstract base class: showUI(), createState(), quick commands, messages
│   ├── agent/            # Middleware plugins: AutoCompactPlugin, ErrorHandlerPlugin
│   ├── quick-command/    # /clear, /exit, /rewind, /resume, /rename, /model-switch, /model-effort
│   ├── debug/            # /session-export, /debug-export-atom, /toggle-log, /status
│   └── custom/           # QuickBashPlugin, QuickCommandInitPlugin
├── tools/                # Agent-callable tools (MicaTool subclass per tool)
├── store/                # nanostores atoms: config, conversation, ui-state, log, stream-handlers
├── components/ui/        # Ink-based React terminal UI (app, conversation, input, dropdown, etc.)
└── prompts/              # System prompt builder: system.md + MICA.md (project instructions)
packages/ink/             # Custom Ink fork — terminal rendering library
MICA.md                   # Project instructions, hot-reloadable (injected into system prompt at startup)
```

### Key Patterns

- **Plugin registration**: `MicaAgent.usePlugin()` in `src/index.ts`. Each plugin extends `MicaPlugin` and implements `onInstall()`.
- **Plugin UI**: Never call `showUI()` / `showUISimple()` in `onInstall()`. Always call lazily — only when there's actual content to display. `MicaPlugin._installed` is `false` during `onInstall`; calling `showUI`/`showUISimple` before it's `true` triggers a `console.error` warning. When content is gone, call `hideUI()` to clean up.
- **Middleware chain**: Registered via `agentTurn.use()` (order matters: first registered = outermost). Currently `AutoCompactPlugin` → `ErrorHandlerPlugin`.
- **State management**: All cross-component state uses nanostores atoms. Ink components subscribe via `useScheduleState()`. Do not use React useState/context for shared state.
- **Rendering**: All terminal output goes through Ink components. No `console.log` (except fatal boot errors via `console.error`). No `process.stderr.write`.
- **Config persistence**: `createPersistedAtom()` in `src/store/config.ts` saves model/effort choices to disk.
- **Project instructions**: Edit `MICA.md` to change agent behavior — it's read at startup and injected into the system prompt via `<project-instructions>` tag.

### Data Flow

1. User types input in TerminalInput → `bootstrap.ts` handler calls `agentTurn.run(text)`
2. `agentTurn.run()` chains through middleware, then calls Anthropic API with system prompt + messages
3. On each iteration: stream response, collect tool calls, execute all tools in parallel, feed results back
4. Loop continues until no tool calls remain and response contains text content
5. Events emitted during the loop (`stream:create`, `tool:use`, `status`, etc.) update nanostores → UI re-renders

### Environment Variables

See `.env.example`. Key vars: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` (defaults to DeepSeek endpoint), `ANTHROPIC_MODEL`, `ANTHROPIC_MAX_TOKENS`.
