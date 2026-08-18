import type { BuiltInCommandItem } from '../commandHost.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from '../services.js';

const MIN_LOOP_INTERVAL_MS = 10_000;

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

  const [rawDuration, ...rest] = trimmed.split(/\s+/);
  const intervalMs = parseDuration(rawDuration ?? '');
  if (intervalMs === null) {
    return { kind: 'error', message: `无法解析循环间隔「${rawDuration}」；请使用 30s / 15m / 2h / 1d 之类的格式` };
  }
  const task = rest.join(' ').trim();
  if (!task) {
    return { kind: 'error', message: '缺少任务描述；用法：/loop <间隔> <任务描述>，例如 /loop 60m 推送一个 BBC 的新闻' };
  }
  if (intervalMs < MIN_LOOP_INTERVAL_MS) {
    return { kind: 'error', message: '循环间隔太短，最少 10 秒' };
  }
  return { kind: 'start', intervalMs, intervalLabel: formatDuration(intervalMs), task };
}

/**
 * 定时循环任务调度器（进程内单例由插件持有）。定时器 unref，不阻止进程退出。
 */
export class LoopController {
  private state: LoopState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deps: { canFire: () => boolean; submit: (text: string, displayText: string) => Promise<unknown> } | null = null;

  get active(): LoopState | null {
    return this.state;
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
    return this.state;
  }

  stop(): void {
    this.clearTimer();
    this.state = null;
    this.deps = null;
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
      '',
      '收到任务消息即开始一次执行，按任务内容完成并简要汇报结果，然后等待下一次触发。',
      '不要询问是否继续，也不要主动结束循环；循环由系统调度，你只需完成每次任务。',
      '如果你是单次执行的子任务，忽略本段指引，专注完成自己的任务即可。',
    ].join('\n');
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
}

export function createLoopCommand(
  _agent: CommandAgent,
  _sessionController: CommandSessionController,
  services: CommandRuntimeServices,
  controller: LoopController,
): BuiltInCommandItem {
  return {
    name: 'loop',
    description: '启动定时循环任务：/loop <间隔> <任务描述>；/loop stop 停止；/loop 查看状态',
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
              '当前没有运行的定时循环任务。用法：/loop <间隔> <任务描述>，例如 /loop 60m 推送一个 BBC 的新闻',
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
