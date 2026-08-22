import type { BuiltInCommandItem } from '../commandHost.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from '../services.js';
import { MicaTool, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';
import { isCompactionNotNeededError } from '@packages/mica-context/index.js';

export const MIN_LOOP_INTERVAL_MS = 10_000;
/** `/loop <任务描述>` 不带间隔时的默认触发间隔（30 分钟）。 */
export const DEFAULT_LOOP_INTERVAL_MS = 30 * 60_000;

const DURATION_UNITS: Record<'s' | 'm' | 'h' | 'd', number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export type LoopParseResult =
  | { kind: 'start'; intervalMs: number; intervalLabel: string; task: string }
  | { kind: 'stop' }
  | { kind: 'status' }
  | { kind: 'error'; message: string };

export type LoopState = {
  intervalMs: number;
  intervalLabel: string;
  task: string;
  ownerSessionId: string | undefined;
  startedAt: number;
  fireCount: number;
  nextFireAt: number;
};

export type LoopStateListener = (state: LoopState | null) => void;

export type LoopStartParams = {
  intervalMs: number;
  intervalLabel: string;
  task: string;
  ownerSessionId: string | undefined;
  canFire: () => boolean;
  submit: (text: string, displayText: string) => Promise<unknown>;
};

export function parseDuration(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  // 纯数字按秒处理（如 `90` = 90 秒）
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.round(Number(trimmed) * 1_000);
  }
  // 支持复合间隔，如 `1h30m`、`45s`、`2d`
  if (!/^(\d+(\.\d+)?[smhd])+$/.test(trimmed)) return null;
  let total = 0;
  let rest = trimmed;
  while (rest.length > 0) {
    const match = /^(\d+(?:\.\d+)?)([smhd])/.exec(rest);
    if (!match) return null;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) return null;
    total += value * DURATION_UNITS[match[2] as 's' | 'm' | 'h' | 'd'];
    rest = rest.slice(match[0].length);
  }
  return Math.round(total);
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.round(hours / 24);
  return `${days} 天`;
}

export function parseLoopArgs(args: string): LoopParseResult {
  const trimmed = args.trim();
  if (!trimmed) return { kind: 'status' };
  const lower = trimmed.toLowerCase();
  if (['stop', 'off', 'cancel', 'end'].includes(lower)) return { kind: 'stop' };
  if (lower === 'status') return { kind: 'status' };

  const [first, ...rest] = trimmed.split(/\s+/);
  const intervalMs = parseDuration(first ?? '');
  if (intervalMs !== null) {
    // 第一个词是间隔：/loop <间隔> <任务描述>
    const task = rest.join(' ').trim();
    if (!task) {
      return { kind: 'error', message: '缺少任务描述；用法：/loop <任务描述>（默认每 30 分钟）或 /loop <间隔> <任务描述>' };
    }
    if (intervalMs < MIN_LOOP_INTERVAL_MS) {
      return { kind: 'error', message: '循环间隔太短，最少 10 秒' };
    }
    return { kind: 'start', intervalMs, intervalLabel: formatDuration(intervalMs), task };
  }
  // 第一个词不是间隔：整个输入作为任务，使用默认间隔
  return {
    kind: 'start',
    intervalMs: DEFAULT_LOOP_INTERVAL_MS,
    intervalLabel: formatDuration(DEFAULT_LOOP_INTERVAL_MS),
    task: trimmed,
  };
}

/**
 * 定时循环任务调度器（进程内单例由插件持有）。定时器 unref，不阻止进程退出。
 */
export class LoopController {
  private state: LoopState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deps: { canFire: () => boolean; submit: (text: string, displayText: string) => Promise<unknown> } | null = null;
  private listeners = new Set<LoopStateListener>();

  get active(): LoopState | null {
    return this.state;
  }

  /** 订阅循环状态变化（start/stop/interval/task/fire 等），返回取消订阅函数。 */
  onStateChange(listener: LoopStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(params: LoopStartParams): LoopState {
    this.clearTimer();
    const now = Date.now();
    this.state = {
      intervalMs: params.intervalMs,
      intervalLabel: params.intervalLabel,
      task: params.task,
      ownerSessionId: params.ownerSessionId,
      startedAt: now,
      fireCount: 0,
      nextFireAt: now,
    };
    this.deps = { canFire: params.canFire, submit: params.submit };
    this.emit();
    return this.state;
  }

  stop(): void {
    this.clearTimer();
    this.state = null;
    this.deps = null;
    this.emit();
  }

  /** 立即执行第一次任务（不等待间隔）。 */
  fireNow(): void {
    this.fire(true);
  }

  /** 返回追加到系统提示词末尾的 loop 模式指引；未运行时为 null。 */
  buildSystemPromptSuffix(): string | null {
    if (!this.state) return null;
    const { intervalLabel, task } = this.state;
    return [
      '# 定时循环任务（Loop）',
      '',
      '当前会话处于定时任务模式：每隔一段时间自动触发一次任务，直到用户执行 `/loop stop` 为止。',
      '',
      `- 触发间隔：每 ${intervalLabel}`,
      `- 每次任务内容：${task}`,
      '- 每轮任务开始前会自动压缩一次会话历史（本地裁剪，不调用模型）；较早轮次的细节可能已被清理',
      '',
      '收到任务消息即开始一次执行，按任务内容完成并简要汇报结果，然后等待下一次触发。',
      '不要询问是否继续，也不要主动结束循环；循环由系统调度，你只需完成每次任务。',
      '用户随时可能提出新的想法、改变方向或对任务内容补充要求：对话中出现与当前任务不同的新需求或新指令时，'
        + '及时用 loop_set_task 更新任务描述，让后续轮次按最新意图执行，而不是沿用旧任务；'
        + '若用户明确表示不再需要循环，用 loop_stop 停止。',
      '如果你是单次执行的子任务，忽略本段指引，专注完成自己的任务即可。',
      '',
      '你可以通过以下工具随时调整循环（例如用户要求改变间隔、内容或停止时）：',
      '- loop_status：查看当前循环状态',
      '- loop_set_interval：修改触发间隔（例如 "30m"、"2h"），修改后从新时刻重新计时',
      '- loop_set_task：修改每次任务内容',
      '- loop_stop：停止循环',
    ].join('\n');
  }

  /** 修改触发间隔并重新计时；未运行时返回 null。 */
  updateInterval(intervalMs: number): LoopState | null {
    if (!this.state) return null;
    this.state.intervalMs = intervalMs;
    this.state.intervalLabel = formatDuration(intervalMs);
    this.scheduleNext();
    this.emit();
    return this.state;
  }

  /** 修改每次任务内容；未运行或内容为空时返回 null。 */
  updateTask(task: string): LoopState | null {
    const trimmed = task.trim();
    if (!this.state || !trimmed) return null;
    this.state.task = trimmed;
    this.emit();
    return this.state;
  }

  private fire(force = false): void {
    if (!this.state || !this.deps) return;
    // 忙时跳过本轮（消息队列会兜底排队，但避免堆积）；下一轮按固定间隔触发。
    if (force || this.deps.canFire()) {
      this.state.fireCount += 1;
      const count = this.state.fireCount;
      const displayText = `⏰ 定时任务第 ${count} 次：${this.state.task}`;
      void this.deps.submit(this.state.task, displayText);
    }
    this.scheduleNext();
    this.emit();
  }

  private scheduleNext(): void {
    if (!this.state) return;
    this.state.nextFireAt = Date.now() + this.state.intervalMs;
    this.clearTimer();
    this.timer = setTimeout(() => this.fire(), this.state.intervalMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emit(): void {
    const state = this.state;
    this.listeners.forEach((listener) => listener(state));
  }
}

export function createLoopCommand(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
  controller: LoopController,
): BuiltInCommandItem {
  return {
    name: 'loop',
    description: '启动定时循环任务：/loop <任务描述>（默认每 30 分钟）或 /loop <间隔> <任务描述>；/loop stop 停止；/loop 查看状态',
    completionItems: [
      { arg: 'stop', description: '停止当前定时循环任务' },
      { arg: 'status', description: '查看当前循环状态' },
    ],
    async action(rawArgs) {
      const ownerSessionId = services.getCurrentAgentSessionId();
      const parsed = parseLoopArgs(rawArgs ?? '');
      switch (parsed.kind) {
        case 'status': {
          const state = controller.active;
          if (!state) {
            services.showNotice(
              '当前没有运行的定时循环任务。用法：/loop <任务描述>（默认每 30 分钟）或 /loop <间隔> <任务描述>，例如 /loop 推送一个 BBC 的新闻',
              ownerSessionId,
              { command: '/loop', status: 'info' },
            );
            return;
          }
          services.showNotice(
            `loop 运行中：每 ${state.intervalLabel} 执行「${state.task}」，已执行 ${state.fireCount} 次，下次约 ${new Date(state.nextFireAt).toLocaleTimeString()}`,
            ownerSessionId,
            { command: '/loop', status: 'info' },
          );
          return;
        }
        case 'stop': {
          if (!controller.active) {
            services.showNotice('当前没有运行的定时循环任务', ownerSessionId, { command: '/loop', status: 'info' });
            return;
          }
          controller.stop();
          services.showNotice('loop 已停止，定时循环任务已取消', ownerSessionId, { command: '/loop', status: 'success' });
          return;
        }
        case 'error': {
          services.showNotice(parsed.message, ownerSessionId, { command: '/loop', status: 'warning' });
          return;
        }
        case 'start': {
          if (!ownerSessionId) {
            services.showNotice('loop 启动失败：当前没有活动的 agent session', undefined, {
              command: '/loop',
              status: 'error',
            });
            return;
          }
          const replacing = controller.active !== null;
          controller.start({
            ...parsed,
            ownerSessionId,
            canFire: () => !services.isAgentBusy(),
            submit: async (text, displayText) => {
              try {
                // 每次运行前先做一次本地裁剪压缩（不调用模型），让每轮在紧凑的历史上开始
                await compactBeforeLoopRun(services, agent, sessionController, ownerSessionId);
                await services.submitAgentSessionInput(ownerSessionId, text, { queueMode: 'after_turn', displayText });
              } catch (error) {
                // 会话已关闭等场景：停止循环并提示，避免反复失败
                controller.stop();
                services.showNotice(
                  `loop 已停止：${error instanceof Error ? error.message : String(error)}`,
                  ownerSessionId,
                  { command: '/loop', status: 'error' },
                );
              }
            },
          });
          services.showNotice(
            `${replacing ? 'loop 已更新并重新计时' : 'loop 已启动'}：每 ${parsed.intervalLabel} 执行「${parsed.task}」，已安排第一次执行`,
            ownerSessionId,
            { command: '/loop', status: 'success' },
          );
          controller.fireNow();
          return;
        }
      }
    },
  };
}

/**
 * 每轮任务开始前压缩一次会话历史。prune-only 本地裁剪不调用模型、不发摘要请求；
 * 会话内容较少无需压缩时静默跳过，压缩失败只提示、不中断循环。
 */
async function compactBeforeLoopRun(
  services: CommandRuntimeServices,
  agent: CommandAgent,
  sessionController: CommandSessionController,
  ownerSessionId: string,
): Promise<void> {
  try {
    await services.compact(agent, sessionController, ownerSessionId, {
      aggressive: true,
      force: true,
      lightweightPrune: true,
      pruneOnly: true,
      pruneOnlyThresholdRatio: 0.3,
      targetContextRatio: 0.35,
      minRecentRounds: 1,
      maxRecentRounds: 3,
      contextWindowSize: agent.config.provider.contextWindowSize,
    });
  } catch (error) {
    if (isCompactionNotNeededError(error)) return;
    services.showNotice(
      `loop 任务前压缩失败（已继续执行）：${error instanceof Error ? error.message : String(error)}`,
      ownerSessionId,
      { command: 'loop', status: 'warning' },
    );
  }
}

export type LoopToolDeps = {
  controller: LoopController;
  services: CommandRuntimeServices;
};

/** 子代理工具上下文带 taskId，loop 工具只能由主 agent 使用（primaryAgentOnly 之外的防御性检查）。 */
function isSubagentCall(callbacks?: ToolExecuteCallbacks): boolean {
  const context = callbacks?.context;
  if (!context || typeof context !== 'object') return false;
  return (context as { taskId?: unknown }).taskId !== undefined;
}

function describeLoop(state: LoopState): string {
  return `定时循环运行中：每 ${state.intervalLabel} 执行「${state.task}」，已执行 ${state.fireCount} 次，下次约 ${new Date(state.nextFireAt).toLocaleTimeString()}，启动于 ${new Date(state.startedAt).toLocaleString()}`;
}

/** 校验循环是否运行且属于当前会话；不满足时返回给模型的提示，满足返回 null。 */
function guardLoop(controller: LoopController, sessionId: string | undefined): string | null {
  const state = controller.active;
  if (!state) return '当前没有运行的定时循环任务';
  if (state.ownerSessionId !== sessionId) {
    return '当前定时循环任务不属于这个会话，无法调整；请切换到启动它的会话，或先执行 /loop stop';
  }
  return null;
}

export class ToolLoopStatus extends MicaTool {
  constructor(private readonly deps: LoopToolDeps) {
    super(
      'loop_status',
      '查看当前定时循环任务的状态：触发间隔、任务内容、已执行次数与下次触发时间。适合在用户询问循环情况或要求调整前先查看。',
      { type: 'object', properties: {}, additionalProperties: false },
      { readOnly: true },
    );
  }

  async execute(_input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    if (isSubagentCall(callbacks)) return 'loop 工具只能在主会话中使用';
    const state = this.deps.controller.active;
    if (!state) return '当前没有运行的定时循环任务';
    return describeLoop(state);
  }

  onToolUseDisplayText(): string {
    return '查看定时循环状态';
  }
}

export class ToolLoopSetInterval extends MicaTool {
  constructor(private readonly deps: LoopToolDeps) {
    super(
      'loop_set_interval',
      '修改定时循环任务的触发间隔并从新时刻重新计时。interval 支持 30s / 15m / 2h / 1d 等格式，纯数字按秒（如 90），最少 10 秒。',
      {
        type: 'object',
        properties: { interval: { type: 'string', description: '新的循环间隔，如 "30m"、"1h30m"、"90"（秒）' } },
        required: ['interval'],
        additionalProperties: false,
      },
    );
  }

  async execute(input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    if (isSubagentCall(callbacks)) return 'loop 工具只能在主会话中使用';
    const sessionId = this.deps.services.getCurrentAgentSessionId?.();
    const guard = guardLoop(this.deps.controller, sessionId);
    if (guard) return guard;

    const interval = typeof input.interval === 'string' ? input.interval : '';
    const intervalMs = parseDuration(interval);
    if (intervalMs === null) {
      return `无法解析循环间隔「${interval}」；请使用 30s / 15m / 2h / 1d 之类的格式`;
    }
    if (intervalMs < MIN_LOOP_INTERVAL_MS) {
      return '循环间隔太短，最少 10 秒';
    }
    const state = this.deps.controller.updateInterval(intervalMs)!;
    const next = new Date(state.nextFireAt).toLocaleTimeString();
    this.deps.services.showNotice(`loop 间隔已调整为每 ${state.intervalLabel}，已重新计时，下次约 ${next}`, sessionId, {
      command: 'loop_set_interval',
      status: 'success',
    });
    return `已更新：每 ${state.intervalLabel} 执行「${state.task}」，下次约 ${next}`;
  }

  onToolUseDisplayText(input: ToolInput): string {
    return `修改循环间隔为 ${String(input.interval ?? '')}`;
  }
}

export class ToolLoopSetTask extends MicaTool {
  constructor(private readonly deps: LoopToolDeps) {
    super(
      'loop_set_task',
      '修改定时循环任务每次执行的任务内容描述。',
      {
        type: 'object',
        properties: { task: { type: 'string', description: '新的任务内容描述' } },
        required: ['task'],
        additionalProperties: false,
      },
    );
  }

  async execute(input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    if (isSubagentCall(callbacks)) return 'loop 工具只能在主会话中使用';
    const sessionId = this.deps.services.getCurrentAgentSessionId?.();
    const guard = guardLoop(this.deps.controller, sessionId);
    if (guard) return guard;

    const task = typeof input.task === 'string' ? input.task.trim() : '';
    if (!task) return '任务内容不能为空';
    const state = this.deps.controller.updateTask(task)!;
    const next = new Date(state.nextFireAt).toLocaleTimeString();
    this.deps.services.showNotice(`loop 任务已更新为「${state.task}」`, sessionId, {
      command: 'loop_set_task',
      status: 'success',
    });
    return `已更新任务：每次执行「${state.task}」，下次约 ${next} 触发`;
  }

  onToolUseDisplayText(input: ToolInput): string {
    const task = typeof input.task === 'string' ? input.task.trim() : '';
    return task ? `修改循环任务为「${task}」` : '修改循环任务';
  }
}

export class ToolLoopStop extends MicaTool {
  constructor(private readonly deps: LoopToolDeps) {
    super(
      'loop_stop',
      '停止当前定时循环任务，取消后续触发。',
      { type: 'object', properties: {}, additionalProperties: false },
    );
  }

  async execute(_input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    if (isSubagentCall(callbacks)) return 'loop 工具只能在主会话中使用';
    const sessionId = this.deps.services.getCurrentAgentSessionId?.();
    const guard = guardLoop(this.deps.controller, sessionId);
    if (guard) return guard;
    this.deps.controller.stop();
    this.deps.services.showNotice('loop 已停止，定时循环任务已取消', sessionId, {
      command: 'loop_stop',
      status: 'success',
    });
    return '已停止定时循环任务。';
  }

  onToolUseDisplayText(): string {
    return '停止定时循环';
  }
}
