import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import setupModelEffortContext from '@packages/mica-builtin-commands/startup/model-effort-context/index.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { VERSION_LABEL } from '@packages/mica-config/brand.js';
import { micaMcp } from '@packages/mica-mcp/index.js';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import {
  AUTO_COMPACT_DEFAULTS,
  normalizeAutoCompactOverride,
  prepareImageForApi,
  pruneAutoCompactOverride,
  resolveAutoCompactSettings,
} from '@packages/mica-common/index.js';
import type { AutoCompactSettings } from '@packages/mica-common/index.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import type { AgentContentBlockParam, AgentQueryContent } from '@packages/mica-agent/index.js';
import {
  CODEX_ERROR_INTERNAL,
  CODEX_ERROR_INVALID_REQUEST,
  CODEX_ERROR_INVALID_PARAMS,
  CODEX_ERROR_METHOD_NOT_FOUND,
  CODEX_METHODS,
  CODEX_NOTIFICATIONS,
  MICA_AUTO_COMPACT_NOTIFICATIONS,
  MICA_BTW_NOTIFICATIONS,
  MICA_METHODS,
  MICA_QUEUE_NOTIFICATIONS,
  MICA_SESSION_NOTIFICATIONS,
  MICA_TASK_NOTIFICATIONS,
  MICA_TURN_NOTIFICATIONS,
  MICA_CAPABILITY_NOTIFICATIONS,
  encodeCodexError,
  encodeCodexNotification,
  encodeCodexResponse,
  parseCodexLine,
  type CodexJsonRpcMessage,
  type CodexRequestId,
  type CodexThread,
  type CodexTurn,
  type CodexUserInput,
  type MicaBackgroundTaskItem,
  type MicaQueueItem,
  type MicaSubagentTaskDetail,
  type MicaSubagentTaskItem,
  type MicaTurnRetrying,
  type MicaWaitTaskItem,
} from '@packages/mica-runtime/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import {
  cleanBackgroundTaskOutput,
  killBackgroundTask as killBackgroundTaskById,
  listBackgroundTasks,
  loadBackgroundTask,
  listActiveWaits,
  micaTools,
  readBackgroundTaskOutput,
  terminateCurrentBackgroundTasks,
  type BackgroundTaskMeta,
} from '@packages/mica-tools/index.js';
import type { WaitRecord } from '@packages/mica-tools/index.js';
import { AgentRuntime } from '../agent/AgentRuntime.js';
import type { AgentRuntimeConfigOverride } from '../agent/AgentRuntimeConfig.js';
import { SubagentTaskManager, type SubagentTaskRecord } from '../agents/SubagentTaskManager.js';
import {
  HeadlessTurnExecutor,
  MAX_TURN_RETRIES,
  REMOTE_TURN_MESSAGE,
  type HeadlessTurnEvent,
  type HeadlessTurnStartResult,
} from '../runtime/HeadlessTurnExecutor.js';
import { attachCodexProjector, type CodexProjector } from '../runtime/CodexProjector.js';
import { AutoCompactController } from '../runtime/autoCompact.js';
import { BtwThreads, readStoredBtwThreads, writeStoredBtwThreads } from '../runtime/btwThread.js';
import { truncateHistoryBeforeUserMessage } from '../runtime/conversationHistory.js';
import { SessionController } from '../session/SessionController.js';
import { ToolAgent } from '../tools/ToolAgent.js';
import { createHeadlessPluginHost, startAsSubmit } from '../headless/HeadlessPluginHost.js';
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
 * Project one background shell task. Shared by the running-only snapshot and
 * the on-demand output request: the latter must also carry the status of a task
 * that already finished (with its exit code), because the snapshot drops it the
 * moment it stops running.
 */
export function projectBackgroundTask(task: BackgroundTaskMeta): MicaBackgroundTaskItem {
  return {
    id: task.id,
    command: task.command,
    cwd: task.cwd,
    shell: task.shell,
    status: task.status,
    startedAt: task.started_at,
    ...(task.finished_at ? { finishedAt: task.finished_at } : {}),
    ...(task.exit_code !== undefined && task.exit_code !== null ? { exitCode: task.exit_code } : {}),
    ...(task.signal ? { signal: task.signal } : {}),
  };
}

/** Project active background shell tasks for the `mica/backgroundTasks/updated`
 * snapshot. Only tasks still starting/running are surfaced (matches the CLI
 * TaskStatusBar, which hides finished rows). */
export function projectBackgroundTasks(tasks: BackgroundTaskMeta[]): MicaBackgroundTaskItem[] {
  return tasks
    .filter((task) => task.status === 'starting' || task.status === 'running')
    .map((task) => projectBackgroundTask(task));
}

/** Project running subagents (foreground + background) for the
 * `mica/subagentTasks/updated` snapshot. Activities are included so the client
 * can render the same in-flight tool rows as the CLI. */
export function projectSubagentTasks(tasks: SubagentTaskRecord[]): MicaSubagentTaskItem[] {
  return tasks
    .filter((task) => task.status === 'running')
    .map((task) => ({
      taskId: task.id,
      ...(task.parent_task_id ? { parentTaskId: task.parent_task_id } : {}),
      subagentType: task.subagent_type,
      description: task.description,
      status: task.status,
      startedAt: task.started_at,
      ...(task.finished_at ? { finishedAt: task.finished_at } : {}),
      activities: (task.activities ?? []).map((activity) => ({
        id: activity.id,
        summary: activity.summary,
        ...(activity.toolName ? { toolName: activity.toolName } : {}),
        startedAt: activity.startedAt,
      })),
    }));
}

/** Project the `wait_for` records that are still waiting for the
 * `mica/waitTasks/updated` snapshot. The records live in mica-tools inside this
 * process, so the host is the only place that can see them; a long blocking
 * wait would otherwise look like a frozen tool row in the desktop app. */
export function projectWaitTasks(waits: WaitRecord[]): MicaWaitTaskItem[] {
  return waits.map((wait) => ({
    id: wait.id,
    kind: wait.kind,
    label: wait.label,
    ...(wait.reason ? { reason: wait.reason } : {}),
    status: wait.status === 'parked' ? 'parked' : 'waiting',
    startedAt: new Date(wait.createdAt).toISOString(),
    polls: wait.polls,
    ...(wait.error ? { detail: wait.error } : wait.detail ? { detail: wait.detail } : {}),
  }));
}

/** Cap the projected result so the on-demand detail response stays small. The
 * record itself keeps up to 200k (in memory), but the desktop modal never needs
 * a whole result inline. Keeps the head, mirroring the transcript clamp. */
const SUBAGENT_DETAIL_RESULT_MAX_CHARS = 40_000;

function clampDetailResult(result: string): string {
  if (result.length <= SUBAGENT_DETAIL_RESULT_MAX_CHARS) return result;
  return `${result.slice(0, SUBAGENT_DETAIL_RESULT_MAX_CHARS)}\n…[truncated]`;
}

/**
 * Project one subagent task (including finished ones) for the desktop's
 * on-demand detail modal. The periodic `mica/subagentTasks/updated` snapshot
 * stays lean; this carries the prompt, streamed timeline, result and usage.
 */
export function projectSubagentTaskDetail(record: SubagentTaskRecord): MicaSubagentTaskDetail {
  return {
    taskId: record.id,
    ...(record.parent_task_id ? { parentTaskId: record.parent_task_id } : {}),
    subagentType: record.subagent_type,
    description: record.description,
    status: record.status,
    startedAt: record.started_at,
    ...(record.finished_at ? { finishedAt: record.finished_at } : {}),
    model: record.model,
    effort: record.effort,
    ...(record.max_turns === undefined ? {} : { maxTurns: record.max_turns }),
    ...(record.context_mode === undefined ? {} : { contextMode: record.context_mode }),
    ...(record.write_mode === undefined ? {} : { writeMode: record.write_mode }),
    ...(record.owned_paths ? { ownedPaths: [...record.owned_paths] } : {}),
    ...(record.context_files ? { contextFiles: [...record.context_files] } : {}),
    ...(record.prompt === undefined ? {} : { prompt: record.prompt }),
    ...(record.result === undefined ? {} : { result: clampDetailResult(record.result) }),
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.usage ? { usage: { ...record.usage } } : {}),
    ...(record.timeline ? { timeline: record.timeline.map((entry) => ({ ...entry })) } : {}),
    ...(record.timeline_truncated ? { timelineTruncated: true } : {}),
  };
}

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
 * after_iteration queue (iteration-boundary injection, matching every busy
 * Enter/Tab/Shift+Tab in the app); `turn/start` starts a fresh turn when idle.
 *
 * Exits when stdin closes or on SIGINT/SIGTERM.
 */
export async function runAppServer(options: AppServerOptions): Promise<void> {
  const writeNotification = (method: string, params: unknown) => {
    process.stdout.write(encodeCodexNotification(method, params));
  };
  /**
   * Non-fatal degradation (stale --dir, failed MCP init, stray rejection).
   * Never a Codex `error` notification: clients treat `error` as terminal for
   * the run, so the host would look crashed even though it keeps serving.
   */
  const writeWarning = (threadId: string, message: string) => {
    try {
      writeNotification(CODEX_NOTIFICATIONS.warning, {
        threadId,
        turnId: '',
        warning: { message },
      });
    } catch {
      // stdout may be gone at shutdown; the call site's console.error is the fallback.
    }
  };
  const disposeModelEffortContext = setupModelEffortContext();
  if (options.cwd) {
    try {
      process.chdir(resolve(options.cwd));
    } catch (error) {
      // A stale/deleted --dir must not kill the whole host: surface the real
      // reason and keep serving from the current directory.
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      writeWarning('', message);
    }
  }

  let agent: AgentRuntime | null = null;
  let sessionController: SessionController | null = null;
  let subagentTasks: SubagentTaskManager | null = null;
  let projector: CodexProjector | null = null;
  let executor: HeadlessTurnExecutor | null = null;
  let autoCompact: AutoCompactController | null = null;
  // 跨请求共享：本进程最近一次从宿主收到的压缩设置（默认值的真相）。
  const autoCompactDefaultSettings: { current: AutoCompactSettings } = {
    current: { ...AUTO_COMPACT_DEFAULTS },
  };
  let btwController: BtwThreads | null = null;
  let pluginHost: ReturnType<typeof createHeadlessPluginHost> | null = null;
  let mcpStarted = false;
  let mcpInitPromise: Promise<unknown> | null = null;
  let sessionId = '';
  let currentTurnId: string | null = null;
  let taskSnapshotTimer: NodeJS.Timeout | null = null;
  // Assigned inside the try block once the host state exists; the request
  // handlers (kill/output) call it to push an immediate snapshot after a
  // mutation instead of waiting for the 1s interval.
  let pushTaskSnapshots: () => void = () => {};

  const cleanup = async (): Promise<void> => {
    if (taskSnapshotTimer) {
      clearInterval(taskSnapshotTimer);
      taskSnapshotTimer = null;
    }
    executor?.abort();
    projector?.dispose();
    // 落盘去抖是 500ms：不在这里刷一次，最后那半秒的回答会随进程一起丢
    // （btw 的问答本来就是唯一副本，没有第二个地方能补回来）。
    btwController?.flush();
    await Promise.all([
      cleanupTask('stop subagents', () => subagentTasks?.stop()),
      cleanupTask('stop background tools', () =>
        terminateCurrentBackgroundTasks({ signal: 'SIGTERM', forceAfterMs: 1500 }),
      ),
      ...(mcpStarted ? [cleanupTask('shut down MCP', () => micaMcp.shutdown(), 5000)] : []),
    ]);
    if (pluginHost) {
      await cleanupTask('stop headless plugins', () => pluginHost!.emitRuntimeStop());
      await cleanupTask('dispose headless plugins', () => pluginHost!.dispose());
    }
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

  const runtimeOverride = resolveRuntimeConfigOverride(micaConfig.get(), options.model, options.variant);

  try {
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

    const hooks = new micaPlugin.HookRegistry();
    agent = new AgentRuntime(runtimeOverride, hooks);
    // 自动压缩：设置与计数由桌面宿主在 turn/start 时下发（常驻 host 只 spawn 一次，
    // 页面上改的阈值/次数只能随 turn 带过来），计数经通知回传宿主持久化。
    autoCompact = new AutoCompactController({
      agent,
      onStatus: (counters) => {
        try {
          writeNotification(MICA_AUTO_COMPACT_NOTIFICATIONS.updated, { threadId: sessionId, ...counters });
        } catch {
          // stdout 在退出流程里可能已经关闭；计数回传失败不该影响 turn。
        }
      },
    });
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

    // By The Way（CLI 的 `/btw`）在桌面端的等价物：输入条上的一个抽屉，每个 tab 一条线程。
    // 线程状态（可复用的子代理 + 问答）只能活在 host 里，回答经通知推回。
    // 持久化到 `$MICA_HOME/btw/<sessionId>.json`，所以关掉 app 再打开，问答与上下文都还在。
    btwController = new BtwThreads({
      agent,
      sessionController,
      onUpdate: (thread) => {
        try {
          writeNotification(MICA_BTW_NOTIFICATIONS.updated, { threadId: sessionId, ...thread });
        } catch {
          // stdout 在退出流程里可能已经关闭；回答推不出去不该影响 host。
        }
      },
      onPersist: (threads) => {
        if (sessionId) writeStoredBtwThreads(sessionId, threads);
      },
    });

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
        // A --model/--variant override must take priority over the session
        // snapshot's provider/model/effort. Without this, resume discards the
        // CLI override (the agent reloaded config from the snapshot inside
        // resume), so `--model deepseek/deepseek-v4-flash` is silently ignored
        // when resuming a session. Mirrors runExec's hasRuntimeOverride check.
        agent.configureForRun(
          hasRuntimeOverride(runtimeOverride)
            ? runtimeOverride
            : {
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
    // 恢复这个会话上次留下的 By The Way 线程（问答 + 子代理消息），
    // 所以关掉 app 再打开，抽屉里的 tab 与上下文都还在。
    if (sessionId && btwController) btwController.restore(readStoredBtwThreads(sessionId));

    // MCP 初始化与 host ready 解耦：交互模式是 UI 先渲染、MCP 插件在
    // runtime:start 后台连接，app-server 之前却把 `await micaMcp.init()` 放在
    // ready 路径上，慢 MCP 会把整个 host 就绪卡住。改成后台初始化后 host 立即
    // 发出首帧快照（可服务），turn/start 开始前才等待 mcpReady——用户打字到
    // 发送之间的间隔通常已覆盖 MCP 初始化，首轮感知延迟接近零。
    // init 失败降级：记录 stderr + 发 warning 通知，host 继续服务（无 MCP 工具），
    // 与交互模式 mcp.mjs 的"初始化失败只报错不崩溃"语义一致，不 exit(1)。
    // 单台 server 连接/超时失败不会走到这里（micaMcp.init 内部 markFailed 后返回），
    // 这里只覆盖配置读取失败等整层失败。
    mcpStarted = true;
    mcpInitPromise = micaMcp
      .init({
        ...(options.mcpConfigPath ? { configPath: resolve(options.mcpConfigPath) } : {}),
        strict: options.strictMcpConfig === true,
        initTimeoutMs: options.mcpInitTimeoutMs,
        parallel: true,
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`MCP init failed: ${message}`);
        writeWarning(sessionId, `MCP init failed: ${message}`);
      });

    /**
     * Start a turn's protocol lifecycle: allocate the turn id, attach a fresh
     * projector (turn deltas are scoped to one turn) and emit turn/started.
     * Driven by the executor's `turn:start` event, not by the turn/start
     * request, so turns the host drains from its own queue (plugin after_turn
     * inputs, leftovers of an aborted turn) get the same lifecycle instead of
     * running invisibly while the client still believes it is idle.
     */
    const beginTurn = (): string => {
      const turnId = randomUUID();
      currentTurnId = turnId;
      projector?.dispose();
      projector = attachCodexProjector(agent!, writeNotification, {
        threadId: sessionId,
        turnId,
        cwd: process.cwd(),
        thinking: options.thinking === true,
      });
      writeNotification(CODEX_NOTIFICATIONS.turnStarted, {
        threadId: sessionId,
        turn: turnSnapshot(turnId, 'inProgress'),
      });
      return turnId;
    };
    const endTurn = () => {
      currentTurnId = null;
      projector?.dispose();
      projector = null;
    };

    executor = new HeadlessTurnExecutor({
      agent,
      sessionController,
      maxTurns: options.maxTurns,
      autoCompact: {
        rewriteIterationMessages: (messages) => autoCompact!.rewriteIterationMessages(messages),
      },
      onEvent: (event) => {
        if (event.type === 'turn:finish') projector?.completeAgentMessage();
        handleTurnEvent(writeNotification, event, sessionId, {
          beginTurn,
          getTurnId: () => currentTurnId,
          endTurn,
        });
      },
    });
    pluginHost = createHeadlessPluginHost({
      hooks,
      agent,
      sessionController,
      subagentTasks,
      isBusy: () => executor!.isBusy,
      onHistoryApplied: () => {
        // A session_* tool replaced the persisted history mid-host; tell the
        // client so it reloads the session instead of keeping stale messages.
        try {
          writeNotification(MICA_SESSION_NOTIFICATIONS.historyReplaced, {
            threadId: sessionId,
          });
        } catch {
          // stdout may be gone at shutdown
        }
      },
      submit: (inputText, submitOptions) => startAsSubmit((input) => executor!.start(input), inputText, submitOptions),
    });
    executor.attachPluginLayer({
      hooks: pluginHost.hooks,
      host: pluginHost,
      queue: pluginHost.queue,
      getConversationMessages: pluginHost.getConversationMessages,
      notices: pluginHost.notices,
    });
    await pluginHost.emitRuntimeStart();

    // Long-lived host state that outlives a single turn: background shell tasks
    // and running subagents (including `run_in_background` ones still active
    // after the parent turn finished). The Codex protocol has no event for
    // either, so push change-driven snapshots so the desktop app can render the
    // same task rows above the composer as the CLI shows above its input.
    let lastBackgroundTasksKey = '';
    let lastSubagentTasksKey = '';
    let lastWaitTasksKey = '';
    pushTaskSnapshots = () => {
      if (!agent || !subagentTasks) return;
      const backgroundTasks = projectBackgroundTasks(listBackgroundTasks({ status: 'all' }));
      const backgroundKey = JSON.stringify(backgroundTasks);
      if (backgroundKey !== lastBackgroundTasksKey) {
        lastBackgroundTasksKey = backgroundKey;
        writeNotification(MICA_TASK_NOTIFICATIONS.backgroundTasksUpdated, {
          threadId: sessionId,
          tasks: backgroundTasks,
        });
      }
      const subagentItems = projectSubagentTasks(subagentTasks.list(agent));
      const subagentKey = JSON.stringify(subagentItems);
      if (subagentKey !== lastSubagentTasksKey) {
        lastSubagentTasksKey = subagentKey;
        writeNotification(MICA_TASK_NOTIFICATIONS.subagentTasksUpdated, {
          threadId: sessionId,
          tasks: subagentItems,
        });
      }
      const waitItems = projectWaitTasks(listActiveWaits());
      const waitKey = JSON.stringify(waitItems);
      if (waitKey !== lastWaitTasksKey) {
        lastWaitTasksKey = waitKey;
        writeNotification(MICA_TASK_NOTIFICATIONS.waitTasksUpdated, {
          threadId: sessionId,
          tasks: waitItems,
        });
      }
    };
    pushTaskSnapshots();
    taskSnapshotTimer = setInterval(pushTaskSnapshots, 1000);
    taskSnapshotTimer.unref?.();
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
  // (e.g. a stray provider/tool promise) must surface to the client instead of
  // exiting with a bare code 1 that the app reports as
  // "mica 进程已退出（code 1）" with no reason. It is non-fatal (the host keeps
  // serving), so it is a warning: an `error` notification would make clients
  // end the run. Uncaught exceptions still terminate after the notification so
  // corrupted state cannot keep serving.
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error(`Unhandled rejection: ${message}`);
    writeWarning(sessionId, `Unhandled rejection: ${message}`);
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
      // Client notification (`initialized`); no handshake gate is enforced, so
      // only `shutdown` matters here.
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
        subagentTasks: subagentTasks!,
        refreshTaskSnapshots: () => pushTaskSnapshots(),
        runtimeOverride,
        executor: executor!,
        autoCompact: autoCompact!,
        autoCompactDefaults: autoCompactDefaultSettings,
        btw: btwController,
        mcpReady: mcpInitPromise ?? Promise.resolve(),
        sessionId,
        setSessionId: (nextSessionId) => {
          sessionId = nextSessionId;
        },
        getCurrentTurnId: () => currentTurnId,
        setCurrentTurnId: (turnId) => {
          currentTurnId = turnId;
        },
        writeNotification,
        writeResponse: (result) => process.stdout.write(encodeCodexResponse(id, result)),
        writeError: (code, errorMessage, data) => process.stdout.write(encodeCodexError(id, code, errorMessage, data)),
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
  /** Live subagent task manager: the desktop detail modal reads records here. */
  subagentTasks: SubagentTaskManager;
  /** Push a fresh background/subagent snapshot after a task mutation. */
  refreshTaskSnapshots: () => void;
  runtimeOverride: AgentRuntimeConfigOverride;
  executor: HeadlessTurnExecutor;
  /** Automatic context compaction state machine (settings + run counters). */
  autoCompact: AutoCompactController;
  /**
   * 宿主上次下发的压缩设置（桌面设置页里的全局默认值）。`mica/autoCompact/get`
   * 用它展示「默认是多少」，会话覆盖则叠在它上面——默认值只有宿主一份，常驻 host
   * 自己不去读配置文件。
   *
   * 每个请求都会新建一份 ctx，所以这里放的是**共享的**持有对象：写到它里面，
   * 下一次请求才读得到（写成 ctx 的普通字段每次都会回落到初始值）。
   */
  autoCompactDefaults: { current: AutoCompactSettings };
  /** By The Way（btw）线程：面板连续追问即 CLI 的 `/btw -continue`。 */
  btw: BtwThreads | null;
  /** Resolves once the background MCP init finished (never rejects). */
  mcpReady: Promise<unknown>;
  sessionId: string;
  setSessionId: (sessionId: string) => void;
  getCurrentTurnId: () => string | null;
  setCurrentTurnId: (turnId: string | null) => void;
  writeNotification: (method: string, params: unknown) => void;
  writeResponse: (result: unknown) => void;
  writeError: (code: number, message: string, data?: unknown) => void;
};

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

const CODEX_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

type CodexRuntimeInputPayload = {
  text: string;
  content?: AgentQueryContent;
};

/** Convert Codex multimodal items to the content blocks understood by Mica. */
export async function codexInputToRuntimePayload(
  input: CodexUserInput[] | undefined,
): Promise<CodexRuntimeInputPayload> {
  if (!Array.isArray(input) || input.length === 0) throw new Error('input must contain at least one item');

  const displayParts: string[] = [];
  const content: AgentContentBlockParam[] = [];
  let hasImage = false;
  for (const item of input) {
    if (!item || typeof item !== 'object') throw new Error('input contains an invalid item');
    if (item.type === 'text') {
      if (typeof item.text !== 'string') throw new Error('text input must contain a string text field');
      displayParts.push(item.text);
      content.push({ type: 'text', text: item.text });
      continue;
    }
    if (item.type !== 'image' && item.type !== 'localImage') throw new Error('unsupported input type');

    hasImage = true;
    const imagePath = item.type === 'localImage' ? item.path : undefined;
    const source = item.type === 'image' ? item.url : undefined;
    const image = await loadCodexImage(source, imagePath);
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.buffer.toString('base64') },
    });
    displayParts.push(imagePath ? `[Image](${imagePath})` : '[Image]');
  }

  const text = displayParts.join('\n').trim();
  if (!text && !hasImage) throw new Error('input must contain at least one text or image item');
  return { text: text || '[Image]', ...(hasImage ? { content } : {}) };
}

async function loadCodexImage(
  source: string | undefined,
  localPath: string | undefined,
): Promise<{ buffer: Buffer; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }> {
  let bytes: Buffer;
  if (localPath) {
    const path = localPath.startsWith('~/') ? resolve(homedir(), localPath.slice(2)) : resolve(localPath);
    bytes = await readFile(path);
  } else if (source?.startsWith('data:')) {
    const match = /^data:[^;,]+;base64,(.*)$/s.exec(source);
    if (!match) throw new Error('image url must be a base64 data URL or an http(s) URL');
    bytes = Buffer.from(match[1]!, 'base64');
  } else if (source?.startsWith('http://') || source?.startsWith('https://')) {
    const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`image download failed with HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > CODEX_IMAGE_MAX_BYTES) throw new Error('image is larger than 20 MiB');
    bytes = Buffer.from(await response.arrayBuffer());
  } else {
    throw new Error('image input requires a local path or image URL');
  }
  if (bytes.length > CODEX_IMAGE_MAX_BYTES) throw new Error('image is larger than 20 MiB');
  return prepareImageForApi(bytes);
}

const MICA_APPROVAL_POLICY = 'never';
const MICA_SANDBOX_POLICY = { type: 'dangerFullAccess' };

/**
 * Mica extension: `turn/start` and `mica/turn/editMessage` may carry `role`.
 * The resident chat host is spawned once, so `--role` never changes for its
 * lifetime; without applying the param here a role switched in the app would
 * stay in the renderer only — the session snapshot keeps the role it was opened
 * with, and the composer silently reverts on the next launch. Applying it
 * before the turn starts is also what makes the turn's running checkpoint (and
 * every later save) persist the new role.
 */
function applyRoleOverride(ctx: HostContext, params: Record<string, unknown>): void {
  const role = paramString(params, 'role');
  if (!role || role === ctx.agent.role) return;
  try {
    ctx.agent.setRole(role);
  } catch (error) {
    // A deleted role file must not block the message: keep the current role and
    // degrade to a non-fatal warning (same policy as resume's role fallback).
    ctx.writeNotification(CODEX_NOTIFICATIONS.warning, {
      threadId: ctx.sessionId,
      turnId: '',
      warning: {
        message: `Role "${role}" could not be applied: ${error instanceof Error ? error.message : String(error)}`,
      },
    });
  }
}

/**
 * Mica extension: `turn/start` and `mica/turn/editMessage` carry the desktop's
 * 自动压缩 settings (thresholds + run limits) together with this session's run
 * counters. The resident host is spawned once and the panel can change the
 * numbers between turns, so per-turn delivery is the only path that reaches it.
 * Unknown/missing field types degrade to the defaults inside the controller.
 */
function applyAutoCompactParams(ctx: HostContext, params: Record<string, unknown>): void {
  if (params.autoCompact === undefined) {
    // 宿主没带设置（exec / codex-family driver）：保留「不压缩」的既有行为，
    // 只把本会话的覆盖应用上去也没有意义，因为下游会拒绝压缩。
    return;
  }
  const raw = (params.autoCompact && typeof params.autoCompact === 'object' ? params.autoCompact : {}) as Record<
    string,
    unknown
  >;
  // 宿主的这份是默认值；本会话改过的键盖在上面。计数（quickRuns/modelRuns/lastRunAt）
  // 仍以宿主账本为准，所以只替换设置部分。
  const base = resolveAutoCompactSettings(AUTO_COMPACT_DEFAULTS, raw);
  ctx.autoCompactDefaults.current = base;
  ctx.autoCompact.setParams({
    ...resolveAutoCompactSettings(base, ctx.agent.autoCompactOverrideSelection),
    quickRuns: raw.quickRuns,
    modelRuns: raw.modelRuns,
    lastRunAt: raw.lastRunAt ?? null,
  });
}

function warnIfCodexPolicyCannotBeEnforced(ctx: HostContext, params: Record<string, unknown>): void {
  const approval = params.approvalPolicy;
  const sandbox = params.sandboxPolicy ?? params.sandbox;
  const approvalIsCompatible = approval === undefined || approval === 'never' || approval === 'unapproved';
  const sandboxText = typeof sandbox === 'string' ? sandbox : JSON.stringify(sandbox);
  const sandboxIsCompatible =
    sandbox === undefined || sandboxText === 'dangerFullAccess' || sandboxText === 'danger-full-access';
  if (approvalIsCompatible && sandboxIsCompatible) return;
  ctx.writeNotification(CODEX_NOTIFICATIONS.warning, {
    threadId: ctx.sessionId,
    turnId: '',
    warning: {
      message:
        'Mica accepts Codex approval/sandbox parameters for protocol compatibility, but does not enforce a sandbox or interactive approval boundary; effective policy is approvalPolicy=never, sandboxPolicy=dangerFullAccess.',
    },
  });
}

function threadResponse(ctx: HostContext): Record<string, unknown> {
  const model = ctx.agent.config.model;
  return {
    thread: threadSnapshot(ctx, model),
    model,
    modelProvider: ctx.agent.config.provider.id,
    role: ctx.agent.role,
    cwd: process.cwd(),
    approvalPolicy: MICA_APPROVAL_POLICY,
    sandboxPolicy: MICA_SANDBOX_POLICY,
  };
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
        userAgent: `${VERSION_LABEL}/app-server`,
        codexHome: process.env.MICA_HOME || '',
        platformFamily: 'unix',
        platformOs: process.platform,
      });
      return;
    }
    case CODEX_METHODS.threadStart: {
      const cwdParam = paramString(params, 'cwd');
      if (cwdParam) process.chdir(resolve(cwdParam));
      warnIfCodexPolicyCannotBeEnforced(ctx, params);
      // A codex-family driver (e.g. Multica) conveys the agent's model via
      // thread/start's `model` field, not via a launch flag. Honor it here like
      // turn/start does, otherwise the requested model is silently replaced by
      // the persisted default provider/model (MUL-…).
      const model = paramString(params, 'model');
      const effort = paramString(params, 'effort');
      if (model || effort) {
        try {
          const override = resolveRuntimeConfigOverride(micaConfig.get(), model, effort);
          ctx.agent.configureForRun(
            {
              providerId: override.providerId,
              model: override.model,
              effort: override.effort,
            },
            true,
          );
          await ensureChatHostModelRule(override.model ?? ctx.agent.config.model);
        } catch (error) {
          ctx.writeError(CODEX_ERROR_INVALID_PARAMS, error instanceof Error ? error.message : String(error));
          return;
        }
      }
      const thread = threadSnapshot(ctx, ctx.agent.config.model);
      ctx.writeNotification(CODEX_NOTIFICATIONS.threadStarted, { thread });
      ctx.writeResponse(threadResponse(ctx));
      return;
    }
    case CODEX_METHODS.threadResume: {
      if (ctx.executor.isBusy) {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, 'cannot resume a thread while a turn is active');
        return;
      }
      const threadId = paramString(params, 'threadId');
      if (!threadId) {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, 'threadId must not be empty');
        return;
      }
      const resumed = ctx.sessionController.resume(threadId);
      if (!resumed.ok) {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, resumed.message);
        return;
      }
      ctx.sessionId = threadId;
      ctx.setSessionId(threadId);
      // Same override-priority logic as the --session resume path above, but a
      // codex-family driver (e.g. Multica) also conveys the model via the
      // thread/resume `model` field (see codex.go thread/resume params). Honor
      // that first so a driver-selected model survives resume instead of being
      // replaced by the CLI override or the persisted snapshot. Order:
      // params.model → CLI --model/--variant → session snapshot.
      const paramsModel = paramString(params, 'model');
      const paramsEffort = paramString(params, 'effort');
      let resumeOverride = ctx.runtimeOverride;
      if (paramsModel || paramsEffort) {
        try {
          resumeOverride = resolveRuntimeConfigOverride(micaConfig.get(), paramsModel, paramsEffort);
        } catch (error) {
          ctx.writeError(CODEX_ERROR_INVALID_PARAMS, error instanceof Error ? error.message : String(error));
          return;
        }
      }
      const overrideModel = resumeOverride.model ?? ctx.agent.config.model;
      await ensureChatHostModelRule(overrideModel);
      ctx.agent.configureForRun(
        hasRuntimeOverride(resumeOverride)
          ? resumeOverride
          : {
              providerId: ctx.agent.config.provider.id,
              model: ctx.agent.config.model,
              effort: ctx.agent.config.effort,
            },
        true,
      );
      const cwdParam = paramString(params, 'cwd');
      if (cwdParam) process.chdir(resolve(cwdParam));
      warnIfCodexPolicyCannotBeEnforced(ctx, params);
      const thread = threadSnapshot(ctx, ctx.agent.config.model);
      ctx.writeNotification(CODEX_NOTIFICATIONS.threadStarted, { thread });
      ctx.writeResponse(threadResponse(ctx));
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
      let input: CodexRuntimeInputPayload;
      try {
        input = await codexInputToRuntimePayload(params.input as CodexUserInput[] | undefined);
      } catch (error) {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, error instanceof Error ? error.message : String(error));
        return;
      }
      warnIfCodexPolicyCannotBeEnforced(ctx, params);
      applyRoleOverride(ctx, params);
      applyAutoCompactParams(ctx, params);
      const model = paramString(params, 'model');
      const effort = paramString(params, 'effort');
      if (model || effort) {
        try {
          // params.model carries the app's full id (`krill/gpt-5.6-luna`), not
          // a bare model name. Resolve provider + model like the CLI does,
          // otherwise the current provider receives an unknown model name and
          // the turn fails immediately with a 400.
          const override = resolveRuntimeConfigOverride(micaConfig.get(), model, effort);
          ctx.agent.configureForRun(
            {
              providerId: override.providerId,
              model: override.model,
              effort: override.effort,
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
      // MCP init 与 host ready 解耦：首个 turn 在这里等后台 MCP 连接完成，
      // 用户打字间隔通常已覆盖初始化，首轮感知延迟接近零。
      await ctx.mcpReady;
      const result = await ctx.executor.start(
        micaRuntime.createRuntimeInput(input.text, 'ui', {
          queueMode: 'after_iteration',
          ...(input.content ? { content: input.content } : {}),
        }),
      );
      if (result !== 'started') {
        // 'rejected': the single queue slot is occupied. 'queued': the plugin
        // layer took the input instead of starting a turn. Either way no turn
        // exists, so no turn/started was emitted — report it instead of
        // answering with a turn the client would wait on forever.
        ctx.setCurrentTurnId(null);
        ctx.writeError(CODEX_ERROR_INTERNAL, turnStartFailureMessage(result));
        return;
      }
      // turn/started was already emitted by the executor's turn:start event.
      const turnId = ctx.getCurrentTurnId();
      if (!turnId) {
        ctx.writeError(CODEX_ERROR_INTERNAL, 'turn started without a turn id');
        return;
      }
      const turn = turnSnapshot(turnId, 'inProgress');
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
      let input: CodexRuntimeInputPayload;
      try {
        input = await codexInputToRuntimePayload(params.input as CodexUserInput[] | undefined);
      } catch (error) {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, error instanceof Error ? error.message : String(error));
        return;
      }
      // Mica extension: carry the client message id through so queue events can
      // correlate with the optimistic message the app already rendered. Codex
      // clients simply never send this field.
      const clientMessageId = typeof params.clientMessageId === 'string' ? params.clientMessageId : undefined;
      const result = await ctx.executor.start(
        micaRuntime.createRuntimeInput(input.text, 'ui', {
          queueMode: 'after_iteration',
          ...(input.content ? { content: input.content } : {}),
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
      if (ctx.executor.isBusy) {
        const threadId = paramString(params, 'threadId');
        const turnId = paramString(params, 'turnId');
        const activeTurnId = ctx.getCurrentTurnId();
        if (threadId && threadId !== ctx.sessionId) {
          ctx.writeError(
            CODEX_ERROR_INVALID_PARAMS,
            `expected active thread id \`${threadId}\` but found \`${ctx.sessionId}\``,
          );
          return;
        }
        if (!turnId) {
          ctx.writeError(CODEX_ERROR_INVALID_PARAMS, 'turnId must not be empty');
          return;
        }
        if (turnId !== activeTurnId) {
          ctx.writeError(
            CODEX_ERROR_INVALID_PARAMS,
            `expected active turn id \`${turnId}\` but found \`${activeTurnId}\``,
          );
          return;
        }
      }
      ctx.executor.abort();
      ctx.writeResponse({});
      return;
    }
    case MICA_METHODS.editMessage: {
      // Mica extension: 改写一条已发送的用户消息并重跑（desktop 双击编辑）。
      // Codex 协议只能追加 turn，历史必须先在 host 侧截断，否则编辑后的内容会
      // 带着旧问答一起发给模型。
      if (ctx.executor.isBusy) {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, 'Mica 正在运行，空闲后才能编辑重发');
        return;
      }
      const prompt = (paramString(params, 'prompt') ?? '').trim();
      const text = (paramString(params, 'text') ?? '').trim();
      if (!prompt || !text) {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, 'prompt 与 text 不能为空');
        return;
      }
      const occurrenceParam = Number(params.occurrenceFromEnd);
      const previous = ctx.agent.getSnapshot();
      const truncated = truncateHistoryBeforeUserMessage(previous, {
        prompt,
        occurrenceFromEnd: Number.isFinite(occurrenceParam) && occurrenceParam > 0 ? occurrenceParam : 1,
      });
      if (!truncated.ok) {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, truncated.message);
        return;
      }
      const model = paramString(params, 'model');
      const effort = paramString(params, 'effort');
      if (model || effort) {
        try {
          const override = resolveRuntimeConfigOverride(micaConfig.get(), model, effort);
          ctx.agent.configureForRun(
            {
              providerId: override.providerId,
              model: override.model,
              effort: override.effort,
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
      // 截断只动 provider history：UI conversationMessages 由 client 从 provider
      // messages 派生（ChatCompletionsClient/ResponsesClient.toConversationMessages），
      // loadSnapshot 会一并重建，所以这里不能单独截 UI 层，否则两边错位。
      ctx.agent.loadSnapshot({ ...previous, ...truncated.snapshot });
      // 必须在 loadSnapshot 之后：loadSnapshot 会按快照里的 role 重置 currentRole，
      // 先应用角色会被上面这份「截断前快照」覆盖回旧角色。
      applyRoleOverride(ctx, params);
      applyAutoCompactParams(ctx, params);
      await ctx.mcpReady;
      // 落盘要在通知之前：turn 启动后的首次保存跑在 executor.start 之后的异步
      // 路径上（runTurn 里先 await parseImageRefs），此刻客户端若直接读文件会拿到
      // 截断后、还没有本轮用户消息的历史，界面上的消息会凭空消失。
      ctx.sessionController.saveCurrent({
        allowEmpty: true,
        conversationMessages: [...ctx.agent.toConversationMessages(), { role: 'user', content: text }],
      });
      ctx.writeNotification(MICA_SESSION_NOTIFICATIONS.historyReplaced, { threadId: ctx.sessionId });
      const result = await ctx.executor.start(
        micaRuntime.createRuntimeInput(text, 'ui', { queueMode: 'after_iteration' }),
      );
      if (result !== 'started') {
        // 新 turn 没起来（单槽队列被占）：把历史恢复成编辑前的样子再通知重载，
        // 否则会话被截断却没有任何东西补回来。
        ctx.agent.loadSnapshot(previous);
        ctx.sessionController.saveCurrent({ allowEmpty: true });
        ctx.writeNotification(MICA_SESSION_NOTIFICATIONS.historyReplaced, { threadId: ctx.sessionId });
        ctx.writeError(CODEX_ERROR_INTERNAL, turnStartFailureMessage(result));
        return;
      }
      const turnId = ctx.getCurrentTurnId();
      if (!turnId) {
        ctx.writeError(CODEX_ERROR_INTERNAL, 'turn started without a turn id');
        return;
      }
      ctx.writeResponse({ turn: turnSnapshot(turnId, 'inProgress') });
      return;
    }
    case MICA_METHODS.queueRecall: {
      // Mica extension: pull a queued after_iteration input back out of the
      // host's single slot so the client can restore it to its composer (the
      // CLI's shift + ←). Not a turn, so it stays usable while one is running —
      // which is exactly when a queue entry exists.
      const clientMessageId = paramString(params, 'clientMessageId');
      const removed = ctx.executor.recall(clientMessageId);
      ctx.writeResponse({
        ok: Boolean(removed),
        input: removed ? inputToQueueItem(removed) : null,
        pending: ctx.executor.pendingInputs.map(inputToQueueItem),
        ...(removed ? {} : { message: '该消息已开始发送或已不在队列中' }),
      });
      return;
    }
    case MICA_METHODS.queueHold: {
      // Mica extension: freeze the queued input for the recall round-trip. The
      // client holds before pulling the entry back into the composer, so an
      // iteration boundary cannot inject the text the user is about to re-edit.
      const clientMessageId = paramString(params, 'clientMessageId');
      const held = params.held !== false;
      const frozen = ctx.executor.holdQueued(clientMessageId, held);
      ctx.writeResponse({
        ok: frozen,
        held: held && frozen,
        pending: ctx.executor.pendingInputs.map(inputToQueueItem),
      });
      return;
    }
    case MICA_METHODS.killBackgroundTask: {
      // Mica extension: background shell tasks are owned by the host process, so
      // the desktop can only stop one through it (mirrors the CLI kill_task tool).
      const taskId = paramString(params, 'taskId');
      if (!taskId) {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, 'taskId must not be empty');
        return;
      }
      const forceAfterParam = Number(params.forceAfterMs);
      const forceAfterMs = Number.isFinite(forceAfterParam) && forceAfterParam >= 0 ? forceAfterParam : 1500;
      const result = await killBackgroundTaskById(taskId, 'SIGTERM', forceAfterMs);
      ctx.refreshTaskSnapshots();
      ctx.writeResponse({
        ok: result.ok,
        message: result.message,
        ...(result.stillRunning === undefined ? {} : { stillRunning: result.stillRunning }),
      });
      return;
    }
    case MICA_METHODS.backgroundTaskOutput: {
      // The periodic snapshot drops a task the moment it stops running, so the
      // response carries its own task projection (status + exit code) too.
      const taskId = paramString(params, 'taskId');
      if (!taskId) {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, 'taskId must not be empty');
        return;
      }
      const meta = loadBackgroundTask(taskId);
      if (!meta) {
        ctx.writeResponse({
          ok: false,
          message: `未知后台任务: ${taskId}`,
          content: '',
          size: 0,
          start: 0,
          end: 0,
          task: null,
        });
        return;
      }
      const tailParam = Number(params.tailBytes);
      const tailBytes = Number.isFinite(tailParam) && tailParam > 0 ? Math.min(Math.floor(tailParam), 200_000) : 32_000;
      const range = readBackgroundTaskOutput(meta, { tailBytes, maxBytes: tailBytes });
      ctx.writeResponse({
        ok: true,
        content: cleanBackgroundTaskOutput(range.content),
        size: range.size,
        start: range.start,
        end: range.end,
        task: projectBackgroundTask(meta),
      });
      return;
    }
    case MICA_METHODS.subagentTaskDetail: {
      // Subagent records (prompt, timeline, result, usage) live only in the
      // host's SubagentTaskManager; the desktop fetches them on demand.
      const taskId = paramString(params, 'taskId');
      if (!taskId) {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, 'taskId must not be empty');
        return;
      }
      const record = ctx.subagentTasks.get(taskId, ctx.agent);
      if (!record) {
        ctx.writeResponse({ ok: false, message: `未找到 subagent 任务: ${taskId}` });
        return;
      }
      ctx.writeResponse({ ok: true, task: projectSubagentTaskDetail(record) });
      return;
    }
    case MICA_METHODS.killSubagentTask: {
      const taskId = paramString(params, 'taskId');
      if (!taskId) {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, 'taskId must not be empty');
        return;
      }
      const record = ctx.subagentTasks.get(taskId, ctx.agent);
      if (!record) {
        ctx.writeResponse({ ok: false, message: `未找到 subagent 任务: ${taskId}` });
        return;
      }
      if (record.status !== 'running') {
        ctx.writeResponse({ ok: false, message: `subagent ${taskId} 当前状态为 ${record.status}，无需停止。` });
        return;
      }
      ctx.subagentTasks.kill(taskId, ctx.agent);
      ctx.refreshTaskSnapshots();
      ctx.writeResponse({ ok: true, message: `已请求停止 subagent ${taskId}。` });
      return;
    }
    case MICA_METHODS.btwAsk: {
      // By The Way（CLI 的 `/btw`）：收下问题立刻返回，回答经
      // `mica/btw/updated` 推回。**不能在这里 await**——请求循环是逐行 await 的，
      // 一次 btw 要发一次模型请求（可能几十秒），阻塞会把 turn/interrupt、
      // turn/steer、mica/queue/recall 全部堵在后面，而那正是主流程运行中要用的。
      // 与 turn 无关：不占队列、不改 run 生命周期，turn 正在跑也可以问。
      if (!ctx.btw) {
        ctx.writeError(CODEX_ERROR_INTERNAL, 'btw 不可用：host 尚未就绪');
        return;
      }
      if (!ctx.sessionId) {
        // 没有会话就没有「主流程对话记录」可作背景，也没有地方记这次开销。
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, 'btw 需要先有一条会话');
        return;
      }
      // 走哪个 tab：带了 threadId 就在那条线程上追问（`/btw -continue`），没带就是
      // 新开一条（抽屉上的 `+`）。host 里找不到这个 id（重启过、被淘汰）时按同一个
      // id 重建，客户端不必自己处理「线程丢了」。
      const threadIdParam = paramString(params, 'threadId') ?? '';
      const question = (paramString(params, 'question') ?? '').trim();
      if (!question) {
        // 空问题 = 只把这条线程建出来（点 `+` 时要先把 id 拿到手才能渲染 tab）。
        if (threadIdParam) {
          ctx.writeResponse({ ok: true, threadId: ctx.btw.ensure(threadIdParam).id });
          return;
        }
        const created = ctx.btw.ensure(null);
        ctx.writeResponse({ ok: true, threadId: created.id });
        return;
      }
      // 回答期间再提交 = 排队等这一条答完（面板的 Enter/Tab），不是并发的第二次提问。
      const asked = ctx.btw.ask(threadIdParam || null, question, {
        queue: params?.queue === true,
      });
      if (!asked.ok) {
        // 业务性拒绝（上一个还在回答）走响应，让面板原样显示原因；
        // 协议层错误才用 writeError。
        ctx.writeResponse({ ok: false, message: asked.message });
        return;
      }
      ctx.writeResponse({ ok: true, threadId: asked.threadId });
      return;
    }
    case MICA_METHODS.btwCompact: {
      // By The Way 的本地快速压缩：线程是一个复用子代理，它的历史只活在这个进程里，
      // 所以只能由 host 压。与 `/compact` 的 toolResultsOnly 同一条路径——不调用模型、
      // 不丢轮次、可重复执行；压完把上下文占用（估算值）随快照推回去。
      if (!ctx.btw) {
        ctx.writeError(CODEX_ERROR_INTERNAL, 'btw 不可用：host 尚未就绪');
        return;
      }
      const result = await ctx.btw.compact(paramString(params, 'threadId'));
      if (!result.ok) {
        // 「没有可清理内容」「正在回答中」都是业务性结论，让面板原样显示原因。
        ctx.writeResponse({ ok: false, message: result.message });
        return;
      }
      ctx.writeResponse({
        ok: true,
        savedTokens: result.savedTokens,
        tokens: result.tokens,
        requests: result.requests,
      });
      return;
    }
    case MICA_METHODS.btwThreads: {
      // 抽屉的 tab 条与「重开 app 后恢复」都读这里：线程活在 host 里，
      // 客户端只知道自己的 id，不知道还有哪些、各自有什么内容。
      if (!ctx.btw) {
        ctx.writeError(CODEX_ERROR_INTERNAL, 'btw 不可用：host 尚未就绪');
        return;
      }
      ctx.writeResponse({ ok: true, threads: ctx.btw.list() });
      return;
    }
    case MICA_METHODS.btwInterrupt: {
      // 停止正在回答的那一问：只发中断信号、立刻响应。收尾（写 aborted 状态、记账、
      // 补历史）在控制器那边做，答案状态仍经 `mica/btw/updated` 推回。
      if (!ctx.btw) {
        ctx.writeError(CODEX_ERROR_INTERNAL, 'btw 不可用：host 尚未就绪');
        return;
      }
      const result = ctx.btw.interrupt(paramString(params, 'threadId'));
      if (!result.ok) {
        ctx.writeResponse({ ok: false, message: result.message });
        return;
      }
      ctx.writeResponse({ ok: true });
      return;
    }
    case MICA_METHODS.btwRecall: {
      // 把排队中的问题取回来（面板排队条的 ✕）。只清槽、不启动任何东西：
      // 那一问还没进模型，撤回是安全的。
      if (!ctx.btw) {
        ctx.writeError(CODEX_ERROR_INTERNAL, 'btw 不可用：host 尚未就绪');
        return;
      }
      const result = ctx.btw.recall(paramString(params, 'threadId'));
      if (!result.ok) {
        ctx.writeResponse({ ok: false, message: result.message });
        return;
      }
      ctx.writeResponse({ ok: true, question: result.question });
      return;
    }
    case MICA_METHODS.btwClose: {
      // 关掉一个 tab。正在回答的那条拒绝：否则答案会连同宿主一起消失
      // （提问已经发出去了，客户端却拿不到结果）。
      if (!ctx.btw) {
        ctx.writeError(CODEX_ERROR_INTERNAL, 'btw 不可用：host 尚未就绪');
        return;
      }
      const closed = ctx.btw.close(paramString(params, 'threadId'));
      if (!closed.ok) {
        ctx.writeResponse({ ok: false, message: closed.message });
        return;
      }
      ctx.writeResponse({ ok: true });
      return;
    }
    case MICA_METHODS.renameSession: {
      // Mica extension: rename the session. The resident host owns the session
      // file and writes it from its in-memory snapshot on every save, so a
      // client-side read-modify-write would be overwritten by the next turn
      // (and is refused outright while one runs). `renameCurrent` keeps the
      // manual title in memory, which is what later saves persist — the same
      // path the CLI's `/rename` takes.
      const title = (paramString(params, 'title') ?? '').trim();
      if (!title) {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, 'title must not be empty');
        return;
      }
      if (!ctx.sessionId) {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, 'rename requires a session');
        return;
      }
      ctx.sessionController.renameCurrent(title);
      ctx.writeResponse({ ok: true, title: ctx.sessionController.getCurrentTitle() ?? title });
      return;
    }
    case MICA_METHODS.capabilitiesGet: {
      // 本会话的能力开关 + 完整目录。目录始终是当前进程的注册表（MCP 重连后随之变化），
      // 开关只属于这条会话，客户端不需要自己拼。
      const selection = ctx.agent.capabilitySelection;
      // 状态来自连接过程，配置来自 config 文件：还没开始连（服务刚起来、或者这一轮
      // 之前从没发过消息）时状态列表是空的，但「本会话禁用哪个 server」仍然可配，
      // 所以用配置补上缺失的名字，状态标成 configured。
      const configuredMcp = await micaMcp.loadConfig();
      const statusByName = new Map(micaMcp.servers.get().map((server) => [server.name, server]));
      ctx.writeResponse({
        ok: true,
        selection,
        skills: micaSkills
          .getLoaded()
          .map((skill) => ({ name: skill.name, description: skill.description }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        tools: micaTools
          .getCatalog()
          .filter((tool) => tool.source !== 'mcp')
          .map((tool) => ({ name: tool.name, description: tool.description, source: tool.source }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        mcpServers: Object.keys(configuredMcp)
          .sort((a, b) => a.localeCompare(b))
          .map((name) => {
            const status = statusByName.get(name);
            return {
              name,
              status: status?.status ?? 'configured',
              toolCount: status?.toolCount ?? 0,
            };
          }),
      });
      return;
    }
    case MICA_METHODS.capabilitiesSet: {
      const raw = params.selection;
      if (!raw || typeof raw !== 'object') {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, 'selection must be an object');
        return;
      }
      let selection;
      try {
        selection = ctx.agent.setCapabilities(raw as Parameters<typeof ctx.agent.setCapabilities>[0]);
      } catch (error) {
        // 运行中拒绝：一轮里的工具集不能中途变化，客户端保留旧面板并在本轮结束后重试。
        ctx.writeResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      // 选择存在会话快照里（不是 config），所以只影响这条会话；落盘后其他窗口/进程
      // 打开同一会话也能读到。
      // 草稿会话（还没有 id）没有可写的文件；首轮保存时会带上这份选择。
      if (ctx.sessionId) ctx.sessionController.saveCurrent({ allowEmpty: true });
      ctx.writeNotification(MICA_CAPABILITY_NOTIFICATIONS.updated, {
        threadId: ctx.sessionId,
        disabledSkills: selection.disabledSkills,
        disabledTools: selection.disabledTools,
        disabledMcpServers: selection.disabledMcpServers,
      });
      ctx.writeResponse({ ok: true, selection });
      return;
    }
    case MICA_METHODS.autoCompactGet: {
      // 三层一起回：默认值（宿主上次下发的）、本会话覆盖、以及合并后的生效值。
      // 面板不做第二套合并逻辑，也就不会出现「面板显示的和实际跑的不一样」。
      const override = ctx.agent.autoCompactOverrideSelection;
      ctx.writeResponse({
        ok: true,
        defaults: ctx.autoCompactDefaults.current,
        override,
        effective: resolveAutoCompactSettings(ctx.autoCompactDefaults.current, override),
      });
      return;
    }
    case MICA_METHODS.autoCompactSet: {
      const raw = params.override;
      if (raw === undefined) {
        ctx.writeError(CODEX_ERROR_INVALID_PARAMS, 'override must be an object');
        return;
      }
      // 空对象 = 恢复默认。只存**与默认值不同**的键：默认值以后调整仍能落到这条会话上，
      // 快照里也不会留下一堆「用户其实没改过」的值。
      const override = ctx.agent.setAutoCompactOverride(
        pruneAutoCompactOverride(normalizeAutoCompactOverride(raw), ctx.autoCompactDefaults.current),
      );
      if (ctx.sessionId) ctx.sessionController.saveCurrent({ allowEmpty: true });
      ctx.writeNotification(MICA_AUTO_COMPACT_NOTIFICATIONS.overrideUpdated, {
        threadId: ctx.sessionId,
        override,
        effective: resolveAutoCompactSettings(ctx.autoCompactDefaults.current, override),
      });
      ctx.writeResponse({
        ok: true,
        override,
        effective: resolveAutoCompactSettings(ctx.autoCompactDefaults.current, override),
      });
      return;
    }
    default:
      ctx.writeError(CODEX_ERROR_METHOD_NOT_FOUND, `Method not found: ${method}`);
      return;
  }
}

/**
 * `turn/start` (and the edit-message replay) failed before any turn existed.
 * `busy-remote` means another process owns this session's turn lease: the app
 * shows this message and rolls its optimistic message back.
 */
function turnStartFailureMessage(result: HeadlessTurnStartResult): string {
  return result === 'busy-remote' ? REMOTE_TURN_MESSAGE : '已有一条排队消息，等待发送或重新编辑';
}

/** Per-turn protocol lifecycle owned by the executor's event stream. */
type TurnLifecycle = {
  /** Allocate a turn id, attach a fresh projector and emit turn/started. */
  beginTurn: () => string;
  getTurnId: () => string | null;
  /** Clear the active turn id and detach the projector. */
  endTurn: () => void;
};

function handleTurnEvent(
  writeNotification: (method: string, params: unknown) => void,
  event: HeadlessTurnEvent,
  sessionId: string,
  lifecycle: TurnLifecycle,
): void {
  switch (event.type) {
    case 'turn:start':
      // Every executor turn owns a turn id and a turn/started, including turns
      // drained from the host queue. The request handler no longer pre-assigns
      // the id: a drained turn used to run with no turn/started and no
      // turn/completed, leaving the client idle while the host rejected its
      // next turn/start with "A turn is already active".
      lifecycle.beginTurn();
      break;
    case 'turn:retrying':
      // The host retries transient provider errors (same policy as the CLI).
      // Log to stderr only: a Codex `error` notification would make the desktop
      // app mark the run as failed and exit instead of waiting for the retry.
      // The Mica extension notification below is what the app renders as
      // "retrying n/5" — stderr never reaches it.
      console.error(
        `[mica] turn will retry (${event.attempt}/${MAX_TURN_RETRIES}) in ${Math.ceil(event.delayMs / 1000)}s: ${
          event.error ?? 'unknown error'
        }`,
      );
      writeNotification(MICA_TURN_NOTIFICATIONS.retrying, {
        threadId: sessionId,
        turnId: lifecycle.getTurnId(),
        attempt: event.attempt,
        maxAttempts: MAX_TURN_RETRIES,
        delayMs: event.delayMs,
        error: event.error ?? '',
      } satisfies MicaTurnRetrying);
      break;
    case 'turn:finish': {
      const turnId = lifecycle.getTurnId();
      lifecycle.endTurn();
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

/** Models whose metadata was already ensured for this host process. The resume
 * path would otherwise resolve the same model twice in a row (once before the
 * session load, once after), and when models.dev is unreachable each attempt
 * blocks up to 15s — resuming a session then looks hung (and the app-server
 * flow tests' 30s host-ready wait fails). A host only needs the rule once per
 * model; a later snapshot model that differs re-enters through a fresh key. */
const ensuredHostModelRules = new Set<string>();
async function ensureChatHostModelRule(model: string): Promise<void> {
  if (!model || ensuredHostModelRules.has(model)) return;
  ensuredHostModelRules.add(model);
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

function hasRuntimeOverride(override: AgentRuntimeConfigOverride): boolean {
  return override.providerId !== undefined || override.model !== undefined || override.effort !== undefined;
}
