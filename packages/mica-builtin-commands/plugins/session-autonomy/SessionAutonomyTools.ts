import { MicaTool, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';
import type { CommandAgent, CommandRuntimeServices } from '@packages/mica-builtin-commands/index.js';

export type PendingSessionOp = { type: 'compact'; input: { preview?: boolean } };

export type SessionToolDeps = {
  services: CommandRuntimeServices;
  queueOp: (ownerKey: string, op: PendingSessionOp) => boolean;
};

type CallerAgent = Pick<CommandAgent, 'taskOwnerId' | 'getSnapshot' | 'config' | 'role'>;

function callerAgent(callbacks?: ToolExecuteCallbacks): CallerAgent | undefined {
  const context = callbacks?.context;
  if (!context || typeof context !== 'object') return undefined;
  // Subagent tool contexts carry a taskId (see ToolAgent); session tools must
  // never be driven from a subagent, even if the subagent shares the parent's
  // tool registry. The primaryAgentOnly filter already hides them, this is a
  // defense-in-depth guard.
  if ((context as { taskId?: unknown }).taskId !== undefined) return undefined;
  const agent = (context as { agent?: unknown }).agent;
  if (!agent || typeof agent !== 'object') return undefined;
  return agent as CallerAgent;
}

function ownerKeyOf(agent: CallerAgent | undefined): string | undefined {
  const key = agent?.taskOwnerId;
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}

function isActiveAgent(services: CommandRuntimeServices, agent: CallerAgent | undefined): boolean {
  const active = services.getCurrentAgent?.();
  return Boolean(agent && active && ownerKeyOf(agent) === ownerKeyOf(active as unknown as CallerAgent));
}

function notAvailable(message: string): string {
  return `session 工具只能在交互式主会话中使用（${message}）`;
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== 'object') return '';
        const text = (block as Record<string, unknown>).text;
        return typeof text === 'string' ? text : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export class ToolSessionInfo extends MicaTool {
  constructor(private readonly deps: SessionToolDeps) {
    super(
      'session_info',
      [
        '查看当前会话的元信息：会话 id/标题/工作目录、provider/model/effort/role、消息数与 token 占用估算。',
        '适合在决定是否压缩、调整提示词或写入记忆前先观察会话状态。',
      ].join(' '),
      { type: 'object', properties: {}, additionalProperties: false },
      { readOnly: true },
    );
  }

  async execute(_input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const agent = callerAgent(callbacks);
    if (!isActiveAgent(this.deps.services, agent)) return notAvailable('未找到当前 agent');
    const snapshot = agent!.getSnapshot();
    const messageCount = snapshot.messages.length;
    const totalChars = snapshot.messages.reduce<number>((sum, message) => sum + extractMessageText(message).length, 0);
    const estimatedTokens = Math.round(totalChars / 3);
    const contextSize = agent!.config.provider.contextWindowSize;
    const sessionId = this.deps.services.getCurrentAgentSessionId?.() ?? '';
    const title = this.deps.services.getCurrentSessionController?.()?.getCurrentTitle?.() ?? '';
    const config = agent!.config;
    const lastUsage = snapshot.lastUsage as { input_tokens?: number; output_tokens?: number } | undefined;
    const lines = [
      `会话 id: ${sessionId || '(未保存)'}`,
      `标题: ${title || '(未命名)'}`,
      `provider: ${config.provider.id}（${config.provider.name ?? ''}）`,
      `model: ${config.model}`,
      `effort: ${config.effort}`,
      `role: ${agent!.role}`,
      `context window: ${contextSize ? `${contextSize.toLocaleString()} tokens` : '未知'}`,
      `消息数: ${messageCount}`,
      `文本量: ${totalChars.toLocaleString()} 字符（约 ${estimatedTokens.toLocaleString()} tokens）`,
    ];
    if (lastUsage) {
      lines.push(`上次 usage: input ${lastUsage.input_tokens ?? '?'} / output ${lastUsage.output_tokens ?? '?'} tokens`);
    }
    if (messageCount > 0 && contextSize) {
      const ratio = Math.round((estimatedTokens / contextSize) * 100);
      lines.push(`估算 context 占用: ~${ratio}%（按文本量粗估，实际以 usage 为准）`);
    }
    return lines.join('\n');
  }

  onToolUseDisplayText(): string {
    return '查看会话信息';
  }
}

export class ToolSessionCompact extends MicaTool {
  constructor(private readonly deps: SessionToolDeps) {
    super(
      'session_compact',
      [
        '压缩当前会话的上下文历史（复用 compact checkpoint 机制）：旧内容本地裁剪为 checkpoint，保留最近若干轮。',
        '压缩在当前对话轮开始前应用，本轮即可看到压缩后的历史。',
        'preview=true 只返回压缩估算（节省多少 tokens），不实际应用。',
        '上下文占用较高（例如 >70%）时优先使用本工具。',
      ].join(' '),
      {
        type: 'object',
        properties: {
          preview: { type: 'boolean', description: '只估算不应用，默认 false' },
        },
        additionalProperties: false,
      },
    );
  }

  async execute(input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const agent = callerAgent(callbacks);
    if (!isActiveAgent(this.deps.services, agent)) return notAvailable('未找到当前 agent');
    const ownerKey = ownerKeyOf(agent);
    const sessionId = this.deps.services.getCurrentAgentSessionId?.();
    const preview = input.preview === true;

    if (preview) {
      const services = this.deps.services;
      const active = services.getCurrentAgent?.();
      const sessionController = services.getCurrentSessionController?.();
      if (!active || !sessionController) return notAvailable('未找到当前会话');
      const result = await services.compact(active, sessionController, sessionId, {
        preview: true,
        aggressive: true,
        force: true,
        lightweightPrune: true,
        contextWindowSize: (agent!.config.provider.contextWindowSize ?? undefined) as number | undefined,
      });
      const saved = Math.round(result.savedTokenEstimate / 1000);
      return [
        `压缩预览（未应用）：`,
        `- 消息数: ${result.beforeCount} -> ${result.afterCount}`,
        `- 预计节省: ~${saved}k tokens (${Math.round(result.savedRatio * 100)}%)`,
        `- 保留最近: ${result.keptCount} 条`,
        result.contextUsageRatio !== undefined
          ? `- 压缩后 context 占用: ${Math.round(result.contextUsageRatio * 100)}%`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    }

    if (!ownerKey) return notAvailable('缺少 agent 标识');
    if (!this.deps.queueOp(ownerKey, { type: 'compact', input: {} })) {
      return '当前已有待应用的会话操作排队，请等待本轮结束后再发起';
    }
    return '已登记会话压缩，将在本轮对话结束后应用。';
  }

  onToolUseDisplayText(input: ToolInput): string {
    return input.preview === true ? '预览压缩估算' : '登记会话压缩';
  }
}
