# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `bun run dev` — Run in development mode (executes TS directly)
- `bun run build` — Build native binary via `bun build --compile` (see `scripts/build.mjs`)
- `bun run format` — Format all files with prettier
- `bun run format:check` — Check formatting

所有改动必须通过 `npx tsc --noEmit` 无 TS 报错。

## Architecture Overview

Mica is a lightweight, plugin-based code agent CLI using **Bun** + **TypeScript** + **React** (custom fork of Ink at `packages/@anthropic/ink/`, imported as `@anthropic/ink`) + **Anthropic SDK**.

### Project Structure

```
claude-code-main          # 只读参考项目，不可修改、不可运行其测试
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
└── prompts/              # System prompt builder: system.md + AGENTS.md (project instructions)
packages/
├── @anthropic/ink/       # Custom Ink fork — terminal rendering library (workspace dependency)
└── ink/                  # Reference-only Ink source, not part of the build
AGENTS.md                   # Project instructions, hot-reloadable (injected into system prompt at startup)
```

### Key Patterns

- **Plugin registration**: `MicaAgent.usePlugin()` in `src/index.ts`. Each plugin extends `MicaPlugin` and implements `onInstall()`.
- **Plugin UI**: Never call `showUI()` / `showUISimple()` in `onInstall()`. Always call lazily — only when there's actual content to display. `MicaPlugin._installed` is `false` during `onInstall`; calling `showUI`/`showUISimple` before it's `true` triggers a `console.error` warning. When content is gone, call `hideUI()` to clean up.
- **Middleware chain**: Registered via `agentTurn.use()` (order matters: first registered = outermost). Currently `AutoCompactPlugin` → `ErrorHandlerPlugin`.
- **State management**: All cross-component state uses nanostores atoms. Ink components subscribe via `useScheduleState()`. Do not use React useState/context for shared state.
- **Rendering**: All terminal output goes through Ink components. No `console.log` (except fatal boot errors via `console.error`). No `process.stderr.write`.
- **Config persistence**: `createPersistedAtom()` in `src/store/config.ts` saves model/effort choices to disk.
- **Project instructions**: Edit `AGENTS.md` to change agent behavior — it's read at startup and injected into the system prompt via `<project-instructions>` tag.
- **Ink imports**: All `src/` imports from Ink use `@anthropic/ink` (tsconfig paths alias). Never use relative paths to `packages/@anthropic/ink/`. `packages/ink/` is a reference copy only — not included in build or type-check.
- **Workspaces**: `packages/@anthropic/ink` is a nested workspace package. `package.json` uses `"workspaces": ["packages/*", "packages/*/*"]` to capture both unscoped and scoped packages.
- **tsconfig include**: Only `src` and `packages/@anthropic/ink` — `packages/ink` is excluded to avoid type errors from its test files.

### Data Flow

1. User types input in TerminalInput → `bootstrap.ts` handler calls `agentTurn.run(text)`
2. `agentTurn.run()` chains through middleware, then calls Anthropic API with system prompt + messages
3. On each iteration: stream response, collect tool calls, execute all tools in parallel, feed results back
4. Loop continues until no tool calls remain and response contains text content
5. Events emitted during the loop (`stream:create`, `tool:use`, `status`, etc.) update nanostores → UI re-renders

### Environment Variables

See `.env.example`. Key vars: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` (defaults to DeepSeek endpoint), `ANTHROPIC_MODEL`, `ANTHROPIC_MAX_TOKENS`.

## Blog 记录

`blogs/` 目录用于记录 mica-code 的开发过程，主题是"从 0 到 1 开发一个 code agent"。

完成一个有价值的任务后，如果涉及以下情况，可以询问用户是否需要写一篇 Blog 记录：
- 设计了一个值得复用的模式或架构决策（如中间件链、插件生命周期）
- 解决了一个非显而易见的 bug 或技术难题
- 引入了新的子系统或模块（如 MCP 集成、Skills 机制）
- 对某个核心流程做了较大重构

询问时一句话即可，例如："这个改动涉及 XX 设计，要不要写篇 Blog 记录一下？"。不要主动帮写，等用户确认后再动手。
