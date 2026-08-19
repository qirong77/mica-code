import { MicaTool, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';
import type { CommandRuntimeServices } from '../services.js';
import { LoopController, MIN_LOOP_INTERVAL_MS, parseDuration, type LoopState } from './loop.js';

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