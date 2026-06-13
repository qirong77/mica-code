# AGENT.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `bun run dev` — Run in development mode (executes TS directly)
- `bun run build` — Build native binary via `bun build --compile` (see `scripts/build.mjs`)
- `bun run prebuild` — Pre-build step (generates `system.md`, etc.)
- `bun run format` — Format all files with prettier
- `bun run format:check` — Check formatting
- `bun run ui` — Run UI component examples for development

所有改动必须通过 `npx tsc --noEmit` 无 TS 报错。

## Architecture Overview

Mica is a lightweight, plugin-based code agent CLI using **Bun** + **TypeScript** + **React** (custom fork of Ink at `packages/@anthropic/ink/`, imported as `@anthropic/ink`) + **Anthropic SDK**.

### Project Structure

```
claude-code-main          # 只读参考项目，不可修改、不可运行其测试
src/
├── index.ts              # Entry: registers plugins, injects memory prompt, calls MicaAgent.run()
├── bootstrap.ts          # Wires TerminalInput.onSubmit → agentTurn.run(), handles input queueing
├── prebuild.ts           # Pre-build: generates prompts/system.md etc.
├── core/
│   ├── agent.ts          # MicaAgent singleton: plugin registration, atom injection, UI access, MCP init
│   └── agentEvents.ts    # Maps agentTurn event stream to nanostores via streamHandlers
├── agent/
│   ├── turn.ts           # AgentTurn: middleware chain → iteration loop with ToolExecutor
│   ├── iterationRunner.ts # Single iteration: stream API call → collect tool_use → execute tools
│   ├── toolExecutor.ts   # Parallel tool execution with timing, status updates, record tracking
│   ├── agentSession.ts   # Manages messagesAtom (append user/assistant/tool_results, context tracking)
│   ├── subagent.ts       # Lightweight sub-agent: non-streaming API loop (used by quick commands)
│   ├── forkedAgent.ts    # Forked agent: independent context, tool-filtered API loop (used by memory)
│   ├── client.ts         # Singleton Anthropic SDK client (reset on provider switch)
│   └── types.ts          # Shared types: AgentTurnEvents, IterationResult, Middleware, etc.
├── plugins/
│   ├── MicaPlugin.ts     # Abstract base class + UIPanelPlugin abstract class
│   ├── agent/            # Middleware plugins: AutoCompactPlugin, ErrorHandlerPlugin
│   ├── quick-command/    # /model, /effort, /provider, /resume, /rename, /rewind, /star,
│   │                     # /compact, /git-change-context, /exit, /clear, /status, /debug-log-export
│   ├── custom/           # QuickCommitPlugin, QuickCommandInitPlugin, QuickCommandSkillsPlugin
│   ├── debug/            # DebugExportLogPlugin
│   ├── mcp/              # QuickCommandMcpPlugin
│   └── memory/           # MemoryPlugin (cross-session + per-session memory extraction)
├── tools/                # Agent-callable tools (MicaTool subclass per tool)
│   ├── MicaTool.ts       # Abstract base with validateInput, executeTimed, onToolUseDisplayText
│   ├── ToolReadFile.ts, ToolWriteFile.ts, ToolEditFile.ts, ToolListFiles.ts
│   ├── ToolGrepSearch.ts, ToolRunShell.ts, ToolWebFetch.ts, ToolSkill.ts
│   └── index.ts          # Tool registry: builtin + MCP tools, findTool, executeTool, getToolDefinitions
├── mcp/                  # Model Context Protocol integration
│   ├── config.ts         # Reads ~/.mica/config.json for MCP server definitions
│   ├── client.ts         # MCP server connection management (stdio + HTTP transports)
│   ├── tools.ts          # Fetches tool definitions from connected MCP servers
│   └── index.ts          # initMcp, reconnectMcpServer, shutdownMcp
├── skills/               # User-installed skills from ~/.mica/skills/ and ~/.claude/skills/
│   ├── types.ts          # Skill interface (name, description, whenToUse, content, baseDir)
│   └── loadSkills.ts     # Parses SKILL.md frontmatter, loads skill directories
├── store/                # nanostores atoms: config, conversation, ui-state, log, stream-handlers
│   ├── config.ts         # Model config (name, maxTokens, effort), API config, effort tokens table
│   ├── providerConfig.ts # Multi-provider support: ~/.mica/provider.json (DeepSeek, Claude, Kimi)
│   ├── uiState.ts        # WorkingStatus, ActiveTool, Command, PluginUI, planMode, pendingInput
│   ├── ui/               # terminal.ts (input/dropdown atoms), session.ts (session index/switching)
│   ├── conversation.ts   # messagesAtom, contextSizeAtom, cacheHitRateAtom, toMessageParams
│   ├── logAtom.ts        # systemLogAtom, sessionToolRecordsAtom
│   ├── streamHandlers.ts # Handlers for thinking/text/tool streaming → nanostores updates
│   ├── createPersistedAtom.ts  # Persisted atoms (writes to ~/.mica/ on change)
│   ├── updateModelOptions.ts   # Fetches available models from provider API
│   └── index.ts
├── components/
│   ├── app.tsx           # Root App component: layout composition
│   ├── index.tsx         # UI singleton: TerminalInput, Conversation, WorkingStatus, etc.
│   ├── input/            # TerminalInput component (line input + hotkey support)
│   ├── conversation/     # Conversation rendering (Markdown support)
│   ├── panels/           # AgentTurnLog, BottomPanel, MessageBar, WorkingStatus, LogView, PluginPanel
│   ├── primitives/       # Reusable: SelectList, KeyHints, StatusRow, Dialog, Spin, Panel, etc.
│   ├── dropdown/         # DropDownSelect, CommandDropdown with quick command handler
│   ├── hooks/            # useScheduleState — nanostores subscription hook
│   └── utils/            # imagePaste (parses inline image refs in user input)
├── prompts/
│   ├── buildSystemPrompt.ts  # SystemPromptBuilder: builds <system>, <context>, <skills>, <memory> etc.
│   ├── index.ts              # Exports promptBuilder, getSystemPrompt(), getPlanModePrompt()
│   └── system.md             # Core system prompt (read at startup, appended to builder)
└── utils/                # repair, compact, format, display, findGitRoot, formatError, fileHistory, uuid, getContextUsage
packages/
├── @anthropic/ink/       # Custom Ink fork — terminal rendering library (workspace dependency)
└── ink/                  # Reference-only Ink source, not part of the build
AGENTS.md                   # Project instructions, injected into system prompt at startup
```

### Key Patterns

- **Plugin registration**: `MicaAgent.usePlugin()` in `src/index.ts`. Each plugin extends `MicaPlugin` and implements `onInstall()`. Order matters for quick commands displayed, and for middleware (first registered = outermost).
- **Plugin UI**: Never call `showUI()` / `showUISimple()` in `onInstall()`. Always call lazily — only when there's actual content to display. `MicaPlugin._installed` is `false` during `onInstall`. When content is gone, call `hideUI()` to clean up.
- **UIPanelPlugin**: Extends MicaPlugin for plugins with interactive UI panels. Provides `showUI()`, `showUISimple()`, `hideUI()`, input placeholder management, and dropdown-reset integration. State managed via internal nanostores atom.
- **Middleware chain**: Registered via `agentTurn.use()` (order matters: first registered = outermost). Currently `AutoCompactPlugin` → `ErrorHandlerPlugin`.
- **State management**: All cross-component state uses nanostores atoms. Ink components subscribe via `useScheduleState()`. Do not use React useState/context for shared state.
- **Rendering**: All terminal output goes through Ink components. No `console.log` (except fatal boot errors via `console.error`). No `process.stderr.write`.
- **Config persistence**: `createPersistedAtom()` in `src/store/createPersistedAtom.ts` saves model/effort choices to `~/.mica/`.
- **Project instructions**: Edit `AGENTS.md` to change agent behavior — it's read at startup and injected into the system prompt via `<project-instructions>` tag.
- **Ink imports**: All `src/` imports from Ink use `@anthropic/ink` (tsconfig paths alias). Never use relative paths to `packages/@anthropic/ink/`. `packages/ink/` is a reference copy only.
- **Workspaces**: `packages/@anthropic/ink` is a nested workspace package. `package.json` uses `"workspaces": ["packages/*", "packages/*/*"]`.

### Provider System

Multi-provider support via `~/.mica/provider.json`. Currently supports DeepSeek, Claude, and Kimi.

- `initProvider()` in `src/store/providerConfig.ts` loads the current provider and sets `api.baseUrl` / `api.apiKey`.
- Provider switching via `/provider` quick command → calls `switchProvider()` which resets the Anthropic client and refetches models.
- Provider config auto-generates from defaults on first run.
- Environment variable fallback: `api_key_env_name` and `api_base_env_name` allow overriding values from env vars.

### MCP (Model Context Protocol)

Dynamically extends the agent with tools from external MCP servers configured in `~/.mica/config.json`.

- On startup, `initMcp()` connects to all configured servers, fetches their tool definitions, and registers them as `MicaTool` instances (prefixed `mcp__<server>__<tool>`).
- Supports stdio (command + args) and HTTP (url) transports.
- `/mcp` quick command shows server status and allows reconnection.
- MCP tools participate in parallel execution with builtin tools.

### Skills System

User-installed skills loaded from `~/.mica/skills/` and `~/.claude/skills/`.

- Each skill is a directory with a `SKILL.md` file containing YAML frontmatter (name, description, when_to_use, argument-hint) and markdown body.
- At startup, skills are injected into the system prompt under `<skills>` tag.
- Agent invokes skills via the `Skill` tool, passing the skill name so ToolSkill can load and inject the correct prompt.
- `/skills` quick command shows loaded skills.

### Memory System

Automatic memory extraction from conversations.

- **Cross-session memory**: Stored in `~/.mica/memory/<project-hash>/`. After every N messages / M tokens, MemoryPlugin spawns a forked agent to extract memories and update `MEMORY.md`.
- **Session memory**: Per-session memory stored in `~/.mica/session-memory/<session-id>.md`. Updated periodically with key decisions, file changes, errors, and pending tasks.
- Memory instructions and the current `MEMORY.md` index are injected into the system prompt at startup via `injectMemorySystemPrompt()`.
- `/memory` quick command shows memory status.

### Plan Mode

Toggleable via `planModeAtom` (persisted). When enabled, the system prompt gets a reminder to only analyze/plan, not execute code changes.

### Data Flow

1. User types input in TerminalInput → `bootstrap.ts` handler calls `agentTurn.run(text)`
2. `agentTurn.run()` chains through middleware, then enters the iteration loop (`coreRun`)
3. Each iteration: `IterationRunner.run()` streams an API call, collects tool_use blocks, emits events
4. If tool calls exist: `ToolExecutor.execute()` runs all tools in parallel, appends results to session
5. Loop continues until no tool calls remain and response has text content (not just thinking)
6. `onIterationComplete` callbacks fire (used by MemoryPlugin for memory extraction)
7. Events emitted (`stream:create`, `tool:use`, `status`, etc.) → `agentEvents.ts` → `streamHandlers.ts` → nanostores → UI re-renders

### Sub-agent / Forked Agent

Two patterns for background/non-interactive agent tasks:

- **Sub-agent** (`src/agent/subagent.ts`): Lightweight, non-streaming API loop. Used by quick commands (e.g., commit message generation). Custom system prompt, optional tools, thinking disabled by default.
- **Forked agent** (`src/agent/forkedAgent.ts`): Full-featured agent with tool restriction (`allowedTools`), turn limit, AbortSignal support, usage tracking. Used by MemoryPlugin for memory extraction.

Both bypass the main agent session and UI — no streaming events, no middleware chain.

### Quick Commands

Full list of `/` commands registered by plugins:

| Command | Plugin | Description |
|---------|--------|-------------|
| `/exit` | BuiltinCommandsPlugin | 退出程序 |
| `/clear` | BuiltinCommandsPlugin | 开始新会话 |
| `/status` | BuiltinCommandsPlugin | 显示当前状态 |
| `/model` | selectPlugin | 切换模型 |
| `/effort` | selectPlugin | 切换 effort level |
| `/provider` | providerPlugin | 切换 API provider |
| `/resume` | resumePlugin | 恢复之前的会话 |
| `/rename` | renamePlugin | 重命名当前会话 |
| `/rewind` | rewindPlugin | 回退消息 |
| `/star` | starPlugin | 星标当前会话 |
| `/compact` | compactPlugin | 压缩上下文 |
| `/git-change-context` | gitChangeContextPlugin | 添加 git diff 到上下文 |
| `/mcp` | QuickCommandMcpPlugin | MCP 服务器管理 |
| `/skills` | QuickCommandSkillsPlugin | 查看已加载的 skills |
| `/memory` | MemoryPlugin | 查看记忆文件 |
| `/commit` | QuickCommitPlugin | 生成 git commit message |
| `/init` | QuickCommandInitPlugin | 初始化项目文件 |
| `/debug-export-log` | DebugExportLogPlugin | 导出调试日志 |

### Environment Variables

See `.env.example`. Key vars: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` (defaults to DeepSeek endpoint), `ANTHROPIC_MODEL`, `ANTHROPIC_MAX_TOKENS`.

Provider system in `~/.mica/provider.json` also supports per-provider env var fallback (e.g., `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`).

### CLI Arguments

- `-p "prompt"` / `--print "prompt"` — Run a single prompt non-interactively and exit.

## Blog 记录

`blogs/` 目录用于记录 mica-code 的开发过程，主题是"从 0 到 1 开发一个 code agent"。

完成一个有价值的任务后，如果涉及以下情况，可以询问用户是否需要写一篇 Blog 记录：
- 设计了一个值得复用的模式或架构决策（如中间件链、插件生命周期）
- 解决了一个非显而易见的 bug 或技术难题
- 引入了新的子系统或模块（如 MCP 集成、Skills 机制）
- 对某个核心流程做了较大重构

询问时一句话即可，例如："这个改动涉及 XX 设计，要不要写篇 Blog 记录一下？"。不要主动帮写，等用户确认后再动手。
