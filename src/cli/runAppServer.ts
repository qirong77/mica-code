import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import setupModelEffortContext from '../../buildin-plugins/model-effort-context/index.mjs';
import { TodoWriteTool } from '../../buildin-plugins/todo/TodoTool.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { micaMcp } from '@packages/mica-mcp/index.js';
import {
  CODEX_ERROR_INTERNAL,
  CODEX_ERROR_INVALID_REQUEST,
  CODEX_ERROR_INVALID_PARAMS,
  CODEX_ERROR_METHOD_NOT_FOUND,
  CODEX_METHODS,
  CODEX_NOTIFICATIONS,
  MICA_QUEUE_NOTIFICATIONS,
  encodeCodexError,
  encodeCodexNotification,
  encodeCodexResponse,
  parseCodexLine,
  type CodexJsonRpcMessage,
  type CodexRequestId,
  type CodexThread,
  type CodexTurn,
  type CodexUserInput,
  type MicaQueueItem,
} from '@packages/mica-runtime/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import { micaTools, terminateCurrentBackgroundTasks } from '@packages/mica-tools/index.js';
import { AgentRuntime } from '../agent/AgentRuntime.js';
import { SubagentTaskManager } from '../agents/SubagentTaskManager.js';
import { HeadlessTurnExecutor, type HeadlessTurnEvent } from '../runtime/HeadlessTurnExecutor.js';
import { attachCodexProjector, type CodexProjector } from '../runtime/CodexProjector.js';
import { SessionController } from '../session/SessionController.js';
import { ToolAgent } from '../tools/ToolAgent.js';
import { resolveRuntimeConfigOverride } from './modelCatalog.js';

export type AppServerOptions = {
  sessionId?: string;
  cwd?: string;
  model?: string;
  variant?: string;
  role?: string;
  maxTurns?: number;
  mcpConfigPath?: string;
  strictMcpConfig?: boolean;
  mcpInitTimeoutMs?: number;
  thinking?: boolean;
};

/**
 * `mica app-server`: a per-session resident process exposing a Codex v2
 * app-server protocol subset over stdio (JSON-RPC style, one JSON object per
 * line, no `jsonrpc` field). The desktop app drives it with
 * `initialize`/`thread/start`/`turn/start`/`turn/steer`/`turn/interrupt` and
 * consumes v2 notifications (`turn/started`, `turn/completed`,
 * `item/agentMessage/delta`, `item/reasoning/textDelta`,
 * `item/commandExecution/outputDelta`, `thread/tokenUsage/updated`, ...).
 *
 * Holds the AgentRuntime, MCP connections and the shared HeadlessTurnExecutor
 * for the whole session lifetime, so repeated turns skip process startup,
 * session reload and MCP re-init. `turn/steer` maps to the executor's
 * after_iteration queue (iteration-boundary injection, matching Shift+Tab in
 * the app); `turn/start` starts a fresh turn when idle.
 *
 * Exits when stdin closes or on SIGINT/SIGTERM.
 */
export async function runAppServer(options: AppServerOptions): Promise<void> {
  const writeNotification = (method: string, params: unknown) => {
    process.stdout.write(encodeCodexNotification(method, params));
  };
  const disposeModelEffortContext = setupModelEffortContext();
  if (options.cwd) {
    try {
      process.chdir(resolve(options.cwd));
    } catch (error) {
      // A stale/deleted --dir must not kill the whole host: notify the client
      // with the real reason and keep serving from the current directory.
      process.stdout.write(
        encodeCodexNotification(CODEX_NOTIFICATIONS.error, {
          error: { message: error instanceof Error ? error.message : String(error) },
          willRetry: false,
          threadId: '',
          turnId: '',
        }),
      );
    }
  }

  let agent: AgentRuntime | null = null;
  let sessionController: SessionController | null = null;
  let subagentTasks: SubagentTaskManager | null = null;
  let todoTool: TodoWriteTool | null = null;
  let projector: CodexProjector | null = null;
  let executor: HeadlessTurnExecutor | null = null;
  let mcpStarted = false;
  let sessionId = '';
  let currentTurnId: string | null = null;
  let initialized = false;

  const cleanup = async (): Promise<void> => {
    executor?.abort();
    projector?.dispose();
    await Promise.all([
      cleanupTask('stop subagents', () => subagentTasks?.stop()),
      cleanupTask('stop background tools', () =>
        terminateCurrentBackgroundTasks({ signal: 'SIGTERM', forceAfterMs: 1500 }),
      ),
      ...(mcpStarted ? [cleanupTask('shut down MCP', () => micaMcp.shutdown(), 5000)] : []),
    ]);
    if (todoTool) micaTools.unregisterRuntime(todoTool);
    micaTools.unregisterRuntime('Agent');
    disposeModelEffortContext();
  };

  const exit = async (code: number): Promise<never> => {
    await cleanup();
    // Flush stdout/stderr before exiting: a bare process.exit(1) right after
    // console.error can drop the buffered reason, leaving the app with only
    // "mica 进程已退出（code 1）" and no explanation.
    await Promise.all([
      new Promise<void>((resolveFlush) => process.stdout.write('', () => resolveFlush())),
      new Promise<void>((resolveFlush) => process.stderr.write('', () => resolveFlush())),
    ]);
    process.exit(code);
  };

  try {
    const runtimeOverride = resolveRuntimeConfigOverride(micaConfig.get(), options.model, options.variant);
    let initialModel = runtimeOverride.model ?? micaConfig.get().model;
    if (!initialModel) {
      const config = micaConfig.get();
      const provider = config.providers.find((item) => item.id === config.provider);
      if (provider?.get_model_url) {
        try {
          await micaConfig.loadProviderModels(provider.id);
          initialModel = runtimeOverride.model ?? micaConfig.get().model;
        } catch {
          // Best-effort: dynamic model discovery may fail in restricted networks.
        }
      }
    }
    await ensureChatHostModelRule(initialModel);

    agent = new AgentRuntime(runtimeOverride);
    sessionController = new SessionController({
      agent,
      config: { apply() {} },
      ui: {
        restore() {
          // Chat host has no interactive UI to restore.
        },
      },
    });
    subagentTasks = new SubagentTaskManager();
    micaTools.registerRuntime(new ToolAgent(agent, subagentTasks));
    todoTool = new TodoWriteTool();
    micaTools.registerRuntime(todoTool, { primaryAgentOnly: true });

    if (options.sessionId) {
      let resumed: { ok: true } | { ok: false; message?: string };
      try {
        resumed = sessionController.resume(options.sessionId);
      } catch (error) {
        // resumeLoaded can throw (e.g. snapshot/provider config issues) instead
        // of returning { ok: false }. Degrade to a fresh session with the real
        // reason surfaced, never exit(1) with a bare code.
        const message = error instanceof Error ? error.message : String(error);
        writeNotification(CODEX_NOTIFICATIONS.error, {
          error: { message },
          willRetry: false,
          threadId: options.sessionId,
          turnId: '',
        });
        console.error(message);
        options.sessionId = undefined;
        resumed = { ok: false, message };
      }
      if (!resumed.ok) {
        writeNotification(CODEX_NOTIFICATIONS.error, {
          error: { message: resumed.message ?? `No conversation found with session ID: ${options.sessionId}` },
          willRetry: false,
          threadId: options.sessionId,
          turnId: '',
        });
        console.error(resumed.message ?? `No conversation found with session ID: ${options.sessionId}`);
        // Degrade to a fresh session instead of killing the host: the client
        // sees the error notification above and can keep chatting.
        options.sessionId = undefined;
      }
      if (resumed.ok) {
        await ensureChatHostModelRule(runtimeOverride.model ?? agent.config.model);
        agent.configureForRun(
          {
            providerId: agent.config.provider.id,
            model: agent.config.model,
            effort: agent.config.effort,
          },
          true,
        );
      }
    }
    if (options.role) agent.setRole(options.role);

    sessionId = sessionController.getCurrentSessionId();

    mcpStarted = true;
    await micaMcp.init({
      ...(options.mcpConfigPath ? { configPath: resolve(options.mcpConfigPath) } : {}),
      strict: options.strictMcpConfig === true,
      initTimeoutMs: options.mcpInitTimeoutMs,
      parallel: true,
    });

    executor = new HeadlessTurnExecutor({
      agent,
      sessionController,
      maxTurns: options.maxTurns,
      onEvent: (event) =>
        handleTurnEvent(writeNotification, event, sessionId, () => {
          const turnId = currentTurnId;
          currentTurnId = null;
          return turnId;
        }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeNotification(CODEX_NOTIFICATIONS.error, {
      error: { message },
      willRetry: false,
      threadId: sessionId || '',
      turnId: '',
    });
    console.error(message);
    await exit(1);
  }

  process.once('SIGINT', () => void exit(0));
  process.once('SIGTERM', () => void exit(0));
  process.once('SIGHUP', () => void exit(0));

  // Guard the long-lived host against silent crashes: an unhandled rejection
  // (e.g. a stray provider/tool promise) must surface as an error notification
  // instead of exiting with a bare code 1 that the app reports as
  // "mica 进程已退出（code 1）" with no reason. Uncaught exceptions still
  // terminate after the notification so corrupted state cannot keep serving.
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error(`Unhandled rejection: ${message}`);
    try {
      writeNotification(CODEX_NOTIFICATIONS.error, {
        error: { message: `Unhandled rejection: ${message}` },
        willRetry: false,
        threadId: sessionId,
        turnId: currentTurnId ?? '',
      });
    } catch {
      // stdout may be gone at shutdown; stderr above is the fallback.
    }
  });
  process.on('uncaughtException', (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Uncaught exception: ${message}`, error instanceof Error ? (error.stack ?? '') : '');
    try {
      writeNotification(CODEX_NOTIFICATIONS.error, {
        error: { message: `Uncaught exception: ${message}` },
        willRetry: false,
        threadId: sessionId,
        turnId: currentTurnId ?? '',
      });
    } catch {
      // ignore
    }
    void exit(1);
  });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let message: CodexJsonRpcMessage | undefined;
    try {
      message = parseCodexLine(line);
    } catch {
      process.stdout.write(encodeCodexError(-32700, CODEX_ERROR_INVALID_REQUEST, 'Parse error'));
      continue;
    }
    if (!message) {
      process.stdout.write(encodeCodexError(-32700, CODEX_ERROR_INVALID_REQUEST, 'Parse error'));
      continue;
    }
    if ('id' in message && 'result' in message) continue; // client response
    if ('id' in message && 'error' in message) continue; // client error
    if (!('method' in message)) continue;
    if (!('id' in message)) {
      // Client notification. `initialized` is the only one codex clients send.
      if (message.method === CODEX_METHODS.clientInitialized) initialized = true;
      if (message.method === 'shutdown') break;
      continue;
    }
    const id = message.id as CodexRequestId;
    const method = message.method;
    const params = (message.params ?? {}) as Record<string, unknown>;
    try {
      await handleCodexRequest(id, method, params, {
        agent: agent!,
        sessionController: sessionController!,
        executor: executor!,
        sessionId,
        getCurrentTurnId: () => currentTurnId,
        setCurrentTurnId: (turnId) => {
          currentTurnId = turnId;
        },
        writeNotification,
        writeResponse: (result) => process.stdout.write(encodeCodexResponse(id, result)),
        writeError: (code, errorMessage, data) => process.stdout.write(encodeCodexError(id, code, errorMessage, data)),
        attachProjector: (turnId) => {
          projector?.dispose();
          projector = attachCodexProjector(agent!, writeNotification, {
            threadId: sessionId,
            turnId,
            cwd: process.cwd(),
            thinking: options.thinking === true,
          });
        },
        initialized,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      process.stdout.write(encodeCodexError(id, CODEX_ERROR_INTERNAL, errorMessage));
    }
  }

  await exit(0);
}

type HostContext = {
  agent: AgentRuntime;
  sessionController: SessionController;
  executor: HeadlessTurnExecutor;
  sessionId: string;
  getCurrentTurnId: () => string | null;
  setCurrentTurnId: (turnId: string | null) => void;
  writeNotification: (method: string, params: unknown) => void;
  writeResponse: (result: unknown) => void;
  writeError: (code: number, message: string, data?: unknown) => void;
  attachProjector: (turnId: string) => void;
  initialized: boolean;
};

function textOf(input: CodexUserInput[] | undefined): string {
  if (!Array.isArray(input)) return '';
  return input
    .filter((item): item is { type: 'text'; text: string } => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
    .trim();
}

function threadSnapshot(ctx: HostContext, model: string): CodexThread {
  const cwd = process.cwd();
  return {
    id: ctx.sessionId,
    status: ctx.executor.isBusy ? { active: { activeFlags: [] } } : 'idle',
    cwd,
    createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
    recencyAt: null,
    cliVersion: 'mica',
    source: 'cli',
    modelProvider: ctx.agent.config.provider.id,
    model,
    name: undefined,
  };
}

function turnSnapshot(turnId: string, status: CodexTurn['status'], error?: string | null): CodexTurn {
  return {
    id: turnId,
    items: [],
    itemsView: 'notLoaded',
    status,
    error: error ? { message: error } : null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

function paramString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value ? value : undefined;
}

async function handleCodexRequest(
  _id: CodexRequestId,
  method: string,
  params: Record<string, unknown>,
  ctx: HostContext,
): Promise<void> {
  switch (method) {
    case CODEX_METHODS.initialize: {
      ctx.writeResponse({
        capabilities: { protocolVersion: 2 },
        userAgent: 'mica-code/app-server',
        codexHome: process.env.MICA_HOME || '',
        platformFamily: 'unix',
        platformOs: process.platform,
      });
      return;
    }
    case CODEX_METHODS.threadStart: {
      const model = ctx.agent.config.model;
      const cwdParam = paramString(params, 'cwd');
      if (cwdParam) process.chdir(resolve(cwdParam));
      ctx.writeResponse({
        thread: threadSnapshot(ctx, model),
        model,
        modelProvider: ctx.agent.config.provider.id,
        cwd: process.cwd(),
        approvalPolicy: { strategy: 'unapproved' },
      });
      return;
    }
    case CODEX_METHODS.turnStart: {
      if (ctx.executor.isBusy) {
        ctx.writeError(
          CODEX_ERROR_INVALID_PARAMS,
          'A turn is already active. Use turn/steer to queue input into the active turn.',
        );
        return;
      }
      const input = textOf(params.input as CodexUserInput[] | undefined);
      if (!input) {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, 'input must contain at least one text item');
        return;
      }
      const model = paramString(params, 'model');
      const effort = paramString(params, 'effort');
      if (model || effort) {
        try {
          ctx.agent.configureForRun(
            {
              providerId: ctx.agent.config.provider.id,
              model: model ?? ctx.agent.config.model,
              effort: (effort as never) ?? ctx.agent.config.effort,
            },
            true,
          );
        } catch (error) {
          ctx.writeError(CODEX_ERROR_INVALID_PARAMS, error instanceof Error ? error.message : String(error));
          return;
        }
      }
      const cwdParam = paramString(params, 'cwd');
      if (cwdParam) process.chdir(resolve(cwdParam));
      const turnId = randomUUID();
      ctx.setCurrentTurnId(turnId);
      ctx.attachProjector(turnId);
      const result = await ctx.executor.start(
        micaRuntime.createRuntimeInput(input, 'ui', { queueMode: 'after_iteration' }),
      );
      if (result === 'rejected') {
        ctx.setCurrentTurnId(null);
        ctx.writeError(CODEX_ERROR_INTERNAL, '已有一条排队消息，等待发送或重新编辑');
        return;
      }
      const turn = turnSnapshot(turnId, 'inProgress');
      ctx.writeNotification(CODEX_NOTIFICATIONS.turnStarted, { threadId: ctx.sessionId, turn });
      ctx.writeResponse({ turn });
      return;
    }
    case CODEX_METHODS.turnSteer: {
      if (!ctx.executor.isBusy) {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, 'no active turn to steer');
        return;
      }
      const expectedTurnId = paramString(params, 'expectedTurnId');
      if (!expectedTurnId) {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, 'expectedTurnId must not be empty');
        return;
      }
      const activeTurnId = ctx.getCurrentTurnId();
      if (expectedTurnId !== activeTurnId) {
        ctx.writeError(
          CODEX_ERROR_INVALID_PARAMS,
          `expected active turn id \`${expectedTurnId}\` but found \`${activeTurnId}\``,
        );
        return;
      }
      const input = textOf(params.input as CodexUserInput[] | undefined);
      if (!input) {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, 'input must contain at least one text item');
        return;
      }
      // Mica extension: carry the client message id through so queue events can
      // correlate with the optimistic message the app already rendered. Codex
      // clients simply never send this field.
      const clientMessageId = typeof params.clientMessageId === 'string' ? params.clientMessageId : undefined;
      const result = await ctx.executor.start(
        micaRuntime.createRuntimeInput(input, 'ui', {
          queueMode: 'after_iteration',
          ...(clientMessageId ? { id: clientMessageId } : {}),
        }),
      );
      if (result === 'rejected') {
        ctx.writeError(CODEX_ERROR_INTERNAL, '已有一条排队消息，等待发送或重新编辑');
        return;
      }
      ctx.writeResponse({ turnId: expectedTurnId });
      return;
    }
    case CODEX_METHODS.turnInterrupt: {
      ctx.executor.abort();
      ctx.writeResponse({});
      return;
    }
    default:
      ctx.writeError(CODEX_ERROR_METHOD_NOT_FOUND, `Method not found: ${method}`);
      return;
  }
}

function handleTurnEvent(
  writeNotification: (method: string, params: unknown) => void,
  event: HeadlessTurnEvent,
  sessionId: string,
  takeTurnId: () => string | null,
): void {
  switch (event.type) {
    case 'turn:start':
      break; // turn/started is emitted by the request handler with the turn id
    case 'turn:finish': {
      const turnId = takeTurnId();
      if (!turnId) break;
      const status = event.status === 'completed' ? 'completed' : event.status === 'aborted' ? 'interrupted' : 'failed';
      const turn: CodexTurn = {
        id: turnId,
        items: [],
        itemsView: 'full',
        status,
        error: event.status === 'error' && event.error ? { message: event.error } : null,
        startedAt: null,
        completedAt: Math.floor(Date.now() / 1000),
        durationMs: event.elapsedMs,
      };
      writeNotification(CODEX_NOTIFICATIONS.turnCompleted, { threadId: sessionId, turn });
      break;
    }
    case 'queued':
    case 'dequeue':
    case 'queue:changed': {
      // Mica extension: the Codex protocol has no queue event, so clients would
      // never see an after_iteration input waiting at the host. Emit incremental
      // `mica/queue/*` notifications; Codex clients ignore the unknown method.
      const notification = turnEventToQueueNotification(event, sessionId);
      if (notification) writeNotification(notification.method, notification.params);
      break;
    }
  }
}

export function turnEventToQueueNotification(
  event: HeadlessTurnEvent,
  sessionId: string,
): { method: string; params: unknown } | null {
  if (event.type !== 'queued' && event.type !== 'dequeue' && event.type !== 'queue:changed') return null;
  const pending = (event.type === 'dequeue' ? [] : (event.pending ?? [])).map(inputToQueueItem);
  const base = { threadId: sessionId };
  if (event.type === 'queued') {
    return {
      method: MICA_QUEUE_NOTIFICATIONS.queued,
      params: {
        ...base,
        input: inputToQueueItem(event.input),
        position: event.position,
        pending,
      },
    };
  }
  if (event.type === 'dequeue') {
    return {
      method: MICA_QUEUE_NOTIFICATIONS.dequeue,
      params: { ...base, input: inputToQueueItem(event.input), pending: [] },
    };
  }
  return { method: MICA_QUEUE_NOTIFICATIONS.changed, params: { ...base, pending } };
}

function inputToQueueItem(input: {
  id: string;
  text: string;
  queueMode?: 'after_iteration' | 'after_turn';
}): MicaQueueItem {
  return {
    id: input.id,
    text: input.text,
    queueMode: input.queueMode ?? null,
  };
}

async function ensureChatHostModelRule(model: string): Promise<void> {
  try {
    await micaConfig.ensureModelRule(model);
  } catch (error) {
    console.error(
      `Model metadata unavailable for ${model}; using generic defaults: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function cleanupTask(label: string, action: () => unknown | Promise<unknown>, timeoutMs = 2000): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`cleanup timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    console.error(`Failed to ${label}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
