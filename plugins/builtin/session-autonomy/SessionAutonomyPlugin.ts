import type { PluginContext } from '@packages/mica-plugin/index.js';
import type { RuntimeTurnAfterHookEvent } from '@packages/mica-runtime/index.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from '@packages/mica-builtin-commands/index.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';
import { micaContext } from '@packages/mica-context/index.js';
import {
  ToolSessionCompact,
  ToolSessionHistory,
  ToolSessionInfo,
  ToolSessionRewrite,
  ToolSessionSetPrompt,
  buildRewriteMessages,
  type PendingSessionOp,
} from './SessionAutonomyTools.js';

const PLUGIN_ID = 'builtin.session-autonomy';

const SESSION_AUTONOMY_GUIDANCE = `# 会话自治（Session Autonomy）

你可以通过以下工具观察和管理当前会话：
- session_info / session_history：查看会话状态与历史，决策前先观察。
- session_compact：上下文占用较高（例如 >70%）时压缩历史（preview 可先看估算）。
- session_rewrite：历史过于冗长时，将全部历史重写为单条精简总结。
- session_set_prompt：系统提示词缺少关键约束时，调整当前会话的提示词覆盖（下一轮生效）。

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
  const promptOverrideByOwner = new Map<string, string>();

  const queueOp = (ownerKey: string, op: PendingSessionOp): boolean => {
    const current = pendingByOwner.get(ownerKey);
    if (current) return false;
    pendingByOwner.set(ownerKey, { ops: [op], queued: true });
    return true;
  };

  const toolDeps = { services, queueOp };

  const registrations = [
    new ToolSessionInfo(toolDeps),
    new ToolSessionHistory(toolDeps),
    new ToolSessionCompact(toolDeps),
    new ToolSessionSetPrompt(toolDeps),
    new ToolSessionRewrite(toolDeps),
  ].map((tool) => {
    if (!ctx.tools) throw new Error('session-autonomy requires ctx.tools');
    const registration = ctx.tools.register(tool, { primaryAgentOnly: true });
    ctx.onDispose(() => registration.dispose());
    return registration;
  });

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
      }
    },
    { pluginId: PLUGIN_ID, priority: 100, failPolicy: 'continue' },
  );
  ctx.onDispose(() => turnAfterDisposable.dispose());

  // Pending ops are applied at the next turn start: the agent is idle then and
  // the provider request has not been built yet, so replacing the client
  // history is safe. Applying inside turn:after would race with the next turn
  // (its request can be issued while the applier is still saving the session).
  const turnBeforeDisposable = ctx.hooks.on<RuntimeTurnBeforeHookEvent>(
    'turn:before',
    async () => {
      const agent = services.getCurrentAgent?.();
      const sessionController = services.getCurrentSessionController?.();
      const sessionId = services.getCurrentAgentSessionId?.();
      if (!agent || !sessionController) return;
      const ownerKey = ownerKeyOf(agent);
      if (!ownerKey) return;
      const pending = pendingByOwner.get(ownerKey);
      if (!pending) return;
      pendingByOwner.delete(ownerKey);

      for (const op of pending.ops) {
        try {
          await applyOp(services, agent, sessionController, sessionId, ownerKey, op, promptOverrideByOwner);
        } catch (error) {
          services.showNotice(`会话自治操作失败: ${error instanceof Error ? error.message : String(error)}`, sessionId, {
            variant: 'error',
            command: 'session-autonomy',
            status: 'error',
          });
        }
      }
    },
    { pluginId: PLUGIN_ID, priority: 10, failPolicy: 'continue' },
  );
  ctx.onDispose(() => turnBeforeDisposable.dispose());

  const promptBuildDisposable = ctx.hooks.on<SystemPromptBuildEvent, { event: SystemPromptBuildEvent }>(
    'system-prompt:build',
    (event) => {
      const ownerKey = ownerKeyOf(event.runtime);
      const parts: string[] = [SESSION_AUTONOMY_GUIDANCE];
      const override = ownerKey ? promptOverrideByOwner.get(ownerKey) : undefined;
      if (override) parts.push(`<session-override>\n${override}\n</session-override>`);
      return { event: { ...event, prompt: `${event.prompt}\n\n${parts.join('\n\n')}` } };
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
  ownerKey: string,
  op: PendingSessionOp,
  promptOverrideByOwner: Map<string, string>,
): Promise<void> {
  if (op.type === 'compact') {
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
    return;
  }

  if (op.type === 'setPrompt') {
    const { mode, text } = op.input;
    if (mode === 'clear') {
      promptOverrideByOwner.delete(ownerKey);
      services.showNotice('session_set_prompt: 已清除系统提示词覆盖，下一轮生效', sessionId, {
        variant: 'compact',
        command: 'session_set_prompt',
        status: 'success',
      });
      return;
    }
    const previous = promptOverrideByOwner.get(ownerKey);
    const next = mode === 'append' && previous ? `${previous}\n\n${text}` : text ?? '';
    promptOverrideByOwner.set(ownerKey, next);
    services.showNotice('session_set_prompt: 已更新系统提示词覆盖，下一轮生效', sessionId, {
      variant: 'compact',
      command: 'session_set_prompt',
      status: 'success',
    });
    return;
  }

  if (op.type === 'rewrite') {
    const snapshot = agent.getSnapshot();
    const beforeCount = snapshot.messages.length;
    const messages = buildRewriteMessages(snapshot.messages, op.input.summary, op.input.keep_recent_rounds);
    if (beforeCount === 0 || messages.length === 0) {
      throw new Error('没有可重写的历史消息');
    }
    const result = services.applySessionHistory
      ? await services.applySessionHistory(agent, sessionController, sessionId, { messages, beforeCount })
      : null;
    services.showNotice(
      `session_rewrite: 历史重写完成，消息 ${result?.beforeCount ?? beforeCount} -> ${result?.afterCount ?? messages.length}`,
      sessionId,
      { variant: 'compact', command: 'session_rewrite', status: 'success' },
    );
    return;
  }
}

function ownerKeyOf(owner: unknown): string | undefined {
  if (!owner || typeof owner !== 'object') return undefined;
  const key = (owner as { taskOwnerId?: unknown }).taskOwnerId;
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}
