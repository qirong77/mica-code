import { MicaTool, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';
import type { CommandAgent, CommandRuntimeServices } from '@packages/mica-builtin-commands/index.js';

export const MAX_PROMPT_OVERRIDE_CHARS = 8_000;
export const MAX_SUMMARY_CHARS = 20_000;
export const MAX_HISTORY_ENTRY_CHARS = 1_500;
export const MAX_HISTORY_RETURN_CHARS = 12_000;
export const MAX_HISTORY_LIMIT = 30;
export const DEFAULT_HISTORY_LIMIT = 10;
export const MAX_KEEP_RECENT_ROUNDS = 10;

export type PendingSessionOp =
  | { type: 'compact'; input: { preview?: boolean } }
  | { type: 'setPrompt'; input: { mode: 'replace' | 'append' | 'clear'; text?: string } }
  | { type: 'rewrite'; input: { summary: string; keep_recent_rounds?: number } };

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

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[截断，共 ${text.length} 字符]`;
}

function messageRole(message: unknown): string {
  if (!message || typeof message !== 'object') return '?';
  const role = (message as Record<string, unknown>).role;
  return typeof role === 'string' ? role : '?';
}

function isArrayContentMessageTemplate(message: unknown): boolean {
  return Boolean(message && typeof message === 'object' && Array.isArray((message as Record<string, unknown>).content));
}

function isResponsesMessageTemplate(message: unknown): boolean {
  return Boolean(message && typeof message === 'object' && (message as Record<string, unknown>).type === 'message');
}

/**
 * Rewrites the whole conversation into a single user summary message, keeping
 * the tail `keepRecentRounds` user-led rounds when requested. Message shape
 * follows the last user message so the result survives both provider protocols.
 */
export function buildRewriteMessages(
  messages: unknown[],
  summary: string,
  keepRecentRounds = 0,
): unknown[] {
  const normalized = summary.trim();
  if (keepRecentRounds <= 0) {
    return [createRewriteSummaryMessage(messages, normalized)];
  }
  let start = 0;
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messageRole(messages[index]) === 'user') {
      seen += 1;
      if (seen === keepRecentRounds) {
        start = index;
        break;
      }
    }
  }
  if (start === 0 && seen < keepRecentRounds) {
    // 历史轮次不足，全部替换为总结
    return [createRewriteSummaryMessage(messages, normalized)];
  }
  return [createRewriteSummaryMessage(messages, normalized), ...messages.slice(start)];
}

function createRewriteSummaryMessage(messages: unknown[], summary: string): unknown {
  const template = [...messages].reverse().find((message) => messageRole(message) === 'user');
  if (isResponsesMessageTemplate(template)) {
    return { type: 'message', role: 'user', content: [{ type: 'input_text', text: summary }] };
  }
  if (isArrayContentMessageTemplate(template)) {
    return { role: 'user', content: [{ type: 'text', text: summary }] };
  }
  return { role: 'user', content: summary };
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

export class ToolSessionHistory extends MicaTool {
  constructor(private readonly deps: SessionToolDeps) {
    super(
      'session_history',
      '分页读取当前会话的对话历史（每条消息截断显示）。start 从 0 开始，limit 默认 10 最大 30。',
      {
        type: 'object',
        properties: {
          start: { type: 'integer', description: '起始消息序号（从 0 开始），默认 0' },
          limit: { type: 'integer', description: `最多返回条数，默认 ${DEFAULT_HISTORY_LIMIT}，最大 ${MAX_HISTORY_LIMIT}` },
        },
        additionalProperties: false,
      },
      { readOnly: true },
    );
  }

  async execute(input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const agent = callerAgent(callbacks);
    if (!isActiveAgent(this.deps.services, agent)) return notAvailable('未找到当前 agent');
    const messages = agent!.getSnapshot().messages;
    const start = typeof input.start === 'number' && Number.isInteger(input.start) && input.start >= 0 ? input.start : 0;
    const limit =
      typeof input.limit === 'number' && Number.isInteger(input.limit)
        ? Math.min(Math.max(input.limit, 1), MAX_HISTORY_LIMIT)
        : DEFAULT_HISTORY_LIMIT;
    const page = messages.slice(start, start + limit);
    if (page.length === 0) return `没有更多历史消息（共 ${messages.length} 条，start=${start}）。`;

    const lines = [`共 ${messages.length} 条消息，显示 ${start}–${start + page.length - 1}：`];
    let totalChars = 0;
    for (const message of page) {
      const text = truncate(extractMessageText(message), MAX_HISTORY_ENTRY_CHARS);
      totalChars += text.length;
      if (totalChars > MAX_HISTORY_RETURN_CHARS) {
        lines.push(`…[输出截断，剩余消息请在下一页查看]`);
        break;
      }
      lines.push(`[${messageRole(message)}] ${text}`);
    }
    return lines.join('\n');
  }

  onToolUseDisplayText(input: ToolInput): string {
    const start = typeof input.start === 'number' ? input.start : 0;
    const limit = typeof input.limit === 'number' ? input.limit : DEFAULT_HISTORY_LIMIT;
    return `读取会话历史 (${start}-${start + limit})`;
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

export class ToolSessionSetPrompt extends MicaTool {
  constructor(private readonly deps: SessionToolDeps) {
    super(
      'session_set_prompt',
      [
        '替换/追加/清除当前会话的系统提示词覆盖（session 级，不写盘，不影响其他会话）。',
        '修改将在下一轮对话生效（当前轮的系统提示词已固定）。',
        '适合在系统提示词缺少关键约束、任务上下文漂移时使用。',
      ].join(' '),
      {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['replace', 'append', 'clear'], description: 'replace=整体替换，append=追加到末尾，clear=清除覆盖，默认 replace' },
          text: { type: 'string', description: `覆盖文本（replace/append 必填，最长 ${MAX_PROMPT_OVERRIDE_CHARS} 字符）` },
        },
        additionalProperties: false,
      },
    );
  }

  async execute(input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const agent = callerAgent(callbacks);
    if (!isActiveAgent(this.deps.services, agent)) return notAvailable('未找到当前 agent');
    const ownerKey = ownerKeyOf(agent);
    const mode = input.mode === 'append' || input.mode === 'clear' ? input.mode : 'replace';
    const text = typeof input.text === 'string' ? input.text : undefined;
    if (mode !== 'clear') {
      if (!text || text.trim().length === 0) return 'mode=replace/append 时 text 不能为空';
      if (text.length > MAX_PROMPT_OVERRIDE_CHARS) {
        return `text 过长（${text.length} 字符），上限 ${MAX_PROMPT_OVERRIDE_CHARS} 字符`;
      }
    }
    if (!ownerKey) return notAvailable('缺少 agent 标识');
    if (!this.deps.queueOp(ownerKey, { type: 'setPrompt', input: { mode, text } })) {
      return '当前已有待应用的会话操作排队，请等待本轮结束后再发起';
    }
    return mode === 'clear' ? '已登记清除系统提示词覆盖，将在下一轮对话生效。' : '已登记系统提示词修改，将在下一轮对话生效。';
  }

  onToolUseDisplayText(input: ToolInput): string {
    const mode = input.mode === 'append' || input.mode === 'clear' ? input.mode : 'replace';
    return `修改系统提示词 (${mode})`;
  }
}

export class ToolSessionRewrite extends MicaTool {
  constructor(private readonly deps: SessionToolDeps) {
    super(
      'session_rewrite',
      [
        '将当前会话的全部历史重写为单条精简总结（作为新的 user 消息），替换掉旧历史，用于上下文精简。',
        '你需要先基于当前对话理解，在 summary 中给出覆盖关键决策、路径、约束和未完成事项的完整总结，然后调用本工具。',
        'keep_recent_rounds 可保留末尾最近 N 轮原始对话（默认 0，全部替换）。',
        '历史重写不可逆（可用 /rewind 恢复到本轮之前），在当前对话轮结束后生效。仅在上下文确实冗长时使用。',
      ].join(' '),
      {
        type: 'object',
        properties: {
          summary: { type: 'string', description: `重写后的精简总结（必填，最长 ${MAX_SUMMARY_CHARS} 字符）` },
          keep_recent_rounds: { type: 'integer', description: `保留末尾最近几轮原始对话，默认 0，最大 ${MAX_KEEP_RECENT_ROUNDS}` },
        },
        required: ['summary'],
        additionalProperties: false,
      },
    );
  }

  async execute(input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const agent = callerAgent(callbacks);
    if (!isActiveAgent(this.deps.services, agent)) return notAvailable('未找到当前 agent');
    const ownerKey = ownerKeyOf(agent);
    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    if (!summary) return 'summary 不能为空';
    if (summary.length > MAX_SUMMARY_CHARS) {
      return `summary 过长（${summary.length} 字符），上限 ${MAX_SUMMARY_CHARS} 字符`;
    }
    const keepRecentRounds =
      typeof input.keep_recent_rounds === 'number' && Number.isInteger(input.keep_recent_rounds)
        ? Math.min(Math.max(input.keep_recent_rounds, 0), MAX_KEEP_RECENT_ROUNDS)
        : 0;
    if (!ownerKey) return notAvailable('缺少 agent 标识');
    if (!this.deps.queueOp(ownerKey, { type: 'rewrite', input: { summary, keep_recent_rounds: keepRecentRounds } })) {
      return '当前已有待应用的会话操作排队，请等待本轮结束后再发起';
    }
    return '已登记历史重写，将在本轮对话结束后生效。';
  }

  onToolUseDisplayText(input: ToolInput): string {
    const keep = typeof input.keep_recent_rounds === 'number' ? input.keep_recent_rounds : 0;
    return keep > 0 ? `登记历史重写 (保留 ${keep} 轮)` : '登记历史重写';
  }
}

