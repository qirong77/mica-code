import { spawnSync } from 'node:child_process';
import { MicaTool, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';
import type { CommandAgent, CommandRuntimeServices } from '@packages/mica-builtin-commands/index.js';
import { listSessionTurnLocks, type SessionTurnLock } from '@packages/mica-session/index.js';

export type PendingSessionOp = { type: 'compact'; input: { preview?: boolean } };

export type SessionToolDeps = {
  services: CommandRuntimeServices;
  queueOp: (ownerKey: string, op: PendingSessionOp) => boolean;
  /** 运行中会话枚举；测试注入用，默认读 `$MICA_HOME/sessions/.turn-locks`。 */
  listTurnLocks?: () => SessionTurnLock[];
  /** 进程描述；测试注入用，默认 `ps -o command=`。 */
  describeProcess?: (pid: number) => string | undefined;
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
      lines.push(
        `上次 usage: input ${lastUsage.input_tokens ?? '?'} / output ${lastUsage.output_tokens ?? '?'} tokens`,
      );
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

const SESSION_READ_GUIDANCE = [
  '如何读这些记录（务必按顺序，避免一次性灌入大量 context）:',
  '- session 文件是完整快照，可能有几十 MB（含图片 Base64 与全部工具调用历史）。不要用 read_file 直接读整个文件。',
  '- 只想了解"对方在处理什么事"时，读 snapshot.conversationMessages：UI 层对话，元素形如 { role: "user"|"assistant", content }，比 snapshot.messages 干净得多。',
  '- 推荐顺序：先 grep_search 关键词确认相关 → grep_search 定位 `"conversationMessages"` 的行号 → read_file 从该 offset 分段读（一次 50-150 行）。',
  '- 需要确认"对方改了哪个文件"时再看 snapshot.messages 里的 tool_calls：同样先 grep_search 目标文件名定位，不要整读。',
  '- 文件结构: { version, revision, id, title, titleSource, createdAt, updatedAt, cwd, turnState, snapshot: { providerId, protocol, model, effort, role, contextWindowSize?, messages[], conversationMessages[], usageHistory[], lastUsage?, subagentUsageHistory? } }',
  '- turnState: running / completed / aborted / error。running 但持有进程已消失，说明上一轮被中断（崩溃残留），不代表现在有人写入。',
].join('\n');

function formatElapsed(startedAt: string): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return '时间未知';
  const elapsed = Date.now() - started;
  if (elapsed < 60_000) return '刚刚开始';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `已运行 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `已运行 ${hours} 小时 ${minutes % 60} 分`;
  return `已运行 ${Math.floor(hours / 24)} 天`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export class ToolSessionPeers extends MicaTool {
  constructor(private readonly deps: SessionToolDeps) {
    super(
      'session_peers',
      [
        '列出当前正在运行的 Mica 实例（其他窗口/终端里的 TUI、mica exec、desktop 的 app-server 进程），返回各自 session 缓存文件路径与读取方法。',
        '当怀疑工作区被另一个 Mica 会话改动、文件内容与预期不符、或想确认是否有别的会话在同一个项目/仓库工作时使用。',
        '只读，不修改任何东西。注意：只列出正在执行 turn 的实例，空闲实例不会改动文件，因此不在列表中。',
      ].join(' '),
      { type: 'object', properties: {}, additionalProperties: false },
      { readOnly: true },
    );
  }

  async execute(_input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const agent = callerAgent(callbacks);
    if (!isActiveAgent(this.deps.services, agent)) return notAvailable('未找到当前 agent');
    const currentSessionId = this.deps.services.getCurrentAgentSessionId?.() ?? '';
    const locks = (this.deps.listTurnLocks ?? listSessionTurnLocks)();
    const describe = this.deps.describeProcess ?? describeProcessCommand;
    const running = locks.filter((lock) => lock.alive);
    const stale = locks.filter((lock) => !lock.alive);
    // Same working directory is the interesting case: that is the instance most
    // likely to touch the files this session is editing.
    const selfLock = running.find((lock) => Boolean(currentSessionId) && lock.sessionId === currentSessionId);
    const sameCwd = (lock: SessionTurnLock): boolean =>
      Boolean(selfLock?.cwd) && lock.sessionId !== selfLock?.sessionId && lock.cwd === selfLock?.cwd;

    const header =
      running.length === 0
        ? '当前没有正在运行的 Mica 会话（按 `$MICA_HOME/sessions/.turn-locks` 的持有进程是否存活判定）。'
        : `正在运行的 Mica 会话：${running.length} 个（按 turn 锁持有进程是否存活判定）`;
    const lines: string[] = [header];

    running.forEach((lock, index) => {
      const isSelf = Boolean(currentSessionId) && lock.sessionId === currentSessionId;
      const command = describe(lock.pid);
      const marker = isSelf ? '（本会话）' : sameCwd(lock) ? '（与本会话同一工作目录）' : '';
      lines.push('', `${index + 1}. ${lock.sessionId}${marker}`);
      lines.push(`   pid: ${lock.pid}${command ? ` · ${truncate(command, 100)}` : ''}`);
      lines.push(`   标题: ${lock.title ?? '(未读到)'}`);
      lines.push(`   cwd: ${lock.cwd ?? '(未读到)'}`);
      const meta = [
        lock.model ? `model ${lock.model}` : '',
        lock.turnState ? `turnState ${lock.turnState}` : '',
        `本轮${formatElapsed(lock.startedAt)}（自 ${lock.startedAt || '未知'}）`,
      ].filter(Boolean);
      lines.push(`   ${meta.join(' · ')}`);
      lines.push(`   session 文件: ${lock.sessionPath}`);
    });

    if (running.length > 0) {
      const others = running.filter((lock) => lock.sessionId !== currentSessionId);
      if (others.length === 0) lines.push('', '除本会话外，没有其他 Mica 会话在运行。');
    }
    if (stale.length > 0) {
      lines.push(
        '',
        `另有 ${stale.length} 个残留 turn 锁（持有进程已退出，当前无人写入）: ${stale
          .map((lock) => `${lock.sessionId}(pid ${lock.pid})`)
          .join(', ')}`,
      );
    }

    lines.push('', SESSION_READ_GUIDANCE);
    return lines.join('\n');
  }

  onToolUseDisplayText(): string {
    return '查看运行中的 Mica 会话';
  }
}

function describeProcessCommand(pid: number): string | undefined {
  try {
    const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 });
    const command = result.stdout?.split('\n')[0]?.trim();
    return command ? command : undefined;
  } catch {
    return undefined;
  }
}
