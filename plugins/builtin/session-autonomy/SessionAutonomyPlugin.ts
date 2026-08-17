import type { PluginContext } from '@packages/mica-plugin/index.js';
import type { RuntimeTurnAfterHookEvent } from '@packages/mica-runtime/index.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from '@packages/mica-builtin-commands/index.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';
import { micaContext } from '@packages/mica-context/index.js';
import { ToolSessionCompact, ToolSessionInfo, type PendingSessionOp } from './SessionAutonomyTools.js';

const PLUGIN_ID = 'builtin.session-autonomy';

const SESSION_AUTONOMY_GUIDANCE = `# 会话自治（Session Autonomy）

你可以通过以下工具观察和管理当前会话：
- session_info：查看会话状态与元信息，决策前先观察。
- session_compact：上下文占用较高（例如 >70%）时压缩历史（preview 可先看估算）。

写操作在当前对话轮结束后生效；操作结果会在对话中收到通知。`;

type PendingQueue = { ops: PendingSessionOp[]; queued: boolean };

type SystemPromptBuildEvent = {
  runtime: unknown;
  prompt: string;
};

type RuntimeTurnBeforeHookEvent = {
  runtime: unknown;
  input: unknown;
  content: unknown;
};

export default function setupSessionAutonomy(ctx: PluginContext): void {
  const host = ctx.services.get(commandHostToken);
  if (!host) throw new Error('session-autonomy requires the builtin command host');
  const services: CommandRuntimeServices = host.services;

  const pendingByOwner = new Map<string, PendingQueue>();
  // In-flight applies per owner: the interactive runtime lets the next turn
  // start while a turn:after applier is still running (the status line shows
  // "completed" before turn:after finishes), so the next turn's turn:before
  // must wait for the applier to finish before the request is built.
  const applyingByOwner = new Map<string, Promise<void>>();

  const queueOp = (ownerKey: string, op: PendingSessionOp): boolean => {
    const current = pendingByOwner.get(ownerKey);
    if (current) return false;
    pendingByOwner.set(ownerKey, { ops: [op], queued: true });
    return true;
  };

  const toolDeps = { services, queueOp };

  const registrations = [new ToolSessionInfo(toolDeps), new ToolSessionCompact(toolDeps)].map((tool) => {
    if (!ctx.tools) throw new Error('session-autonomy requires ctx.tools');
    const registration = ctx.tools.register(tool, { primaryAgentOnly: true });
    ctx.onDispose(() => registration.dispose());
    return registration;
  });

  const applyPendingOps = async (sessionId: string | undefined): Promise<void> => {
    const agent = services.getCurrentAgent?.();
    const sessionController = services.getCurrentSessionController?.();
    if (!agent || !sessionController) return;
    const ownerKey = ownerKeyOf(agent);
    if (!ownerKey) return;
    await applyingByOwner.get(ownerKey);
    const pending = pendingByOwner.get(ownerKey);
    if (!pending) return;
    pendingByOwner.delete(ownerKey);
    const run = (async () => {
      for (const op of pending.ops) {
        try {
          await applyOp(services, agent, sessionController, sessionId, op);
        } catch (error) {
          services.showNotice(`会话自治操作失败: ${error instanceof Error ? error.message : String(error)}`, sessionId, {
            variant: 'error',
            command: 'session-autonomy',
            status: 'error',
          });
        }
      }
    })().finally(() => {
      applyingByOwner.delete(ownerKey);
    });
    applyingByOwner.set(ownerKey, run);
    await run;
  };

  // Pending ops are applied at the end of the turn that queued them: the agent
  // is idle and the save for that turn is done, so replacing the client
  // history (and saving the session) is safe and the UI reflects the new
  // history immediately instead of waiting for the next user message.
  // Priority 50 keeps this ahead of message-queue's turn:after (100), which
  // starts the next turn; emitting would otherwise race the applier against
  // the next turn's request build. turn:before below stays as a fallback for
  // one-shot headless runs that never emit turn:after.
  const turnAfterDisposable = ctx.hooks.on<RuntimeTurnAfterHookEvent>(
    'turn:after',
    async (event) => {
      const ownerKey = ownerKeyOf(event.owner);
      if (!ownerKey) return;
      const pending = pendingByOwner.get(ownerKey);
      if (!pending) return;
      if (event.outcome !== 'completed') {
        pendingByOwner.delete(ownerKey);
        services.showNotice('会话自治操作已取消（本轮未正常完成）', services.getCurrentAgentSessionId?.(), {
          variant: 'compact',
          command: 'session-autonomy',
          status: 'warning',
        });
        return;
      }
      await applyPendingOps(services.getCurrentAgentSessionId?.());
    },
    { pluginId: PLUGIN_ID, priority: 50, failPolicy: 'continue' },
  );
  ctx.onDispose(() => turnAfterDisposable.dispose());

  // Fallback applier for hosts without a turn:after (one-shot `mica exec`
  // drains pending ops by re-emitting turn:before after the queue empties).
  const turnBeforeDisposable = ctx.hooks.on<RuntimeTurnBeforeHookEvent>(
    'turn:before',
    async () => {
      const sessionId = services.getCurrentAgentSessionId?.();
      await applyPendingOps(sessionId);
    },
    { pluginId: PLUGIN_ID, priority: 10, failPolicy: 'continue' },
  );
  ctx.onDispose(() => turnBeforeDisposable.dispose());

  const promptBuildDisposable = ctx.hooks.on<SystemPromptBuildEvent, { event: SystemPromptBuildEvent }>(
    'system-prompt:build',
    (event) => {
      return { event: { ...event, prompt: `${event.prompt}\n\n${SESSION_AUTONOMY_GUIDANCE}` } };
    },
    { pluginId: PLUGIN_ID, priority: 10, failPolicy: 'continue' },
  );
  ctx.onDispose(() => promptBuildDisposable.dispose());

  void registrations;
}

async function applyOp(
  services: CommandRuntimeServices,
  agent: CommandAgent,
  sessionController: CommandSessionController,
  sessionId: string | undefined,
  op: PendingSessionOp,
): Promise<void> {
  if (op.type !== 'compact') return;
  const snapshot = agent.getSnapshot();
  const service = new micaContext.CompactionService();
  let result: import('@packages/mica-context/index.js').CompactResult;
  try {
    result = await service.compact({
      messages: snapshot.messages,
      options: {
        aggressive: true,
        force: true,
        lightweightPrune: true,
        pruneOnly: true,
        pruneOnlyThresholdRatio: 0.3,
        targetContextRatio: 0.35,
        minRecentRounds: 1,
        maxRecentRounds: 3,
        contextWindowSize: agent.config.provider.contextWindowSize,
      },
      // pruneOnly 只做本地裁剪，绝不触发 LLM 摘要
      summarize: async () => {
        throw new Error('prune-only compaction must not summarize');
      },
    });
  } catch (error) {
    if (micaContext.isCompactionNotNeededError(error)) {
      services.showNotice('session_compact: 会话内容较少，无需压缩', sessionId, {
        variant: 'compact',
        command: 'session_compact',
        status: 'info',
      });
      return;
    }
    throw error;
  }
  if (!services.applySessionHistory) {
    throw new Error('当前运行环境不支持会话历史替换');
  }
  await services.applySessionHistory(agent, sessionController, sessionId, {
    messages: result.messages,
    beforeCount: result.beforeCount,
  });
  const saved = Math.round(result.savedTokenEstimate / 1000);
  services.showNotice(
    `session_compact: 完成，消息 ${result.beforeCount} -> ${result.afterCount}，节省 ~${saved}k tokens (${Math.round(result.savedRatio * 100)}%)`,
    sessionId,
    { variant: 'compact', command: 'session_compact', status: 'success' },
  );
  // Notify after showNotice so a reloading client sees the completion notice too.
  services.onSessionHistoryApplied?.();
}

function ownerKeyOf(owner: unknown): string | undefined {
  if (!owner || typeof owner !== 'object') return undefined;
  const key = (owner as { taskOwnerId?: unknown }).taskOwnerId;
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}
