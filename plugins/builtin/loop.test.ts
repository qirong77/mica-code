import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';
import { LoopController, parseDuration, parseLoopArgs } from '@packages/mica-builtin-commands/index.js';
import type { MicaTool } from '@packages/mica-tools/index.js';
import setupLoop from './loop.js';

describe('parseDuration', () => {
  it('parses unit durations', () => {
    expect(parseDuration('60m')).toBe(3_600_000);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('1.5h')).toBe(5_400_000);
  });

  it('treats a bare number as seconds', () => {
    expect(parseDuration('90')).toBe(90_000);
    expect(parseDuration('0')).toBe(0);
  });

  it('rejects invalid durations', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('m')).toBeNull();
    expect(parseDuration('60x')).toBeNull();
    expect(parseDuration('h1m')).toBeNull();
  });
});

describe('parseLoopArgs', () => {
  it('returns status for empty input', () => {
    expect(parseLoopArgs('')).toEqual({ kind: 'status' });
  });

  it('returns stop for stop/off/cancel', () => {
    expect(parseLoopArgs('stop')).toEqual({ kind: 'stop' });
    expect(parseLoopArgs('off')).toEqual({ kind: 'stop' });
    expect(parseLoopArgs('cancel')).toEqual({ kind: 'stop' });
    expect(parseLoopArgs('STATUS')).toEqual({ kind: 'status' });
  });

  it('parses interval and task', () => {
    const result = parseLoopArgs('60m 推送一个 BBC 的新闻');
    expect(result).toMatchObject({ kind: 'start', intervalMs: 3_600_000, intervalLabel: '1 小时', task: '推送一个 BBC 的新闻' });
  });

  it('rejects a missing task', () => {
    expect(parseLoopArgs('60m')).toMatchObject({ kind: 'error' });
  });

  it('rejects an invalid interval', () => {
    const result = parseLoopArgs('abc 推送新闻');
    expect(result).toMatchObject({ kind: 'error' });
    if (result.kind === 'error') expect(result.message).toContain('无法解析循环间隔');
  });

  it('rejects an interval shorter than the minimum', () => {
    expect(parseLoopArgs('5s 推送新闻')).toMatchObject({ kind: 'error' });
  });
});

describe('LoopController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires immediately on start, reschedules on interval, stops on stop()', () => {
    const controller = new LoopController();
    const submit = vi.fn(async () => undefined);
    controller.start({
      intervalMs: 60_000,
      intervalLabel: '1 分钟',
      task: '推送新闻',
      ownerSessionId: 's1',
      canFire: () => true,
      submit,
    });

    expect(controller.active?.fireCount).toBe(0);
    expect(controller.buildSystemPromptSuffix()).toContain('定时循环任务');
    expect(controller.buildSystemPromptSuffix()).toContain('推送新闻');

    controller.fireNow();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(controller.active?.fireCount).toBe(1);
    expect(submit).toHaveBeenCalledWith('推送新闻', expect.stringContaining('定时任务第 1 次'));

    vi.advanceTimersByTime(60_000);
    expect(submit).toHaveBeenCalledTimes(2);

    controller.stop();
    vi.advanceTimersByTime(120_000);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(controller.active).toBeNull();
    expect(controller.buildSystemPromptSuffix()).toBeNull();
  });

  it('skips a fire while busy and continues on the next interval', () => {
    const controller = new LoopController();
    let busy = true;
    const submit = vi.fn(async () => undefined);
    controller.start({
      intervalMs: 60_000,
      intervalLabel: '1 分钟',
      task: 't',
      ownerSessionId: 's1',
      canFire: () => !busy,
      submit,
    });
    controller.fireNow(); // 立即执行不受 busy 影响
    expect(submit).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000); // busy -> skip
    expect(submit).toHaveBeenCalledTimes(1);

    busy = false;
    vi.advanceTimersByTime(60_000); // idle -> fire
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('restart replaces the previous loop', () => {
    const controller = new LoopController();
    const submit = vi.fn(async () => undefined);
    controller.start({
      intervalMs: 60_000,
      intervalLabel: '1 分钟',
      task: '旧任务',
      ownerSessionId: 's1',
      canFire: () => true,
      submit,
    });
    controller.fireNow();
    controller.start({
      intervalMs: 3_600_000,
      intervalLabel: '1 小时',
      task: '新任务',
      ownerSessionId: 's1',
      canFire: () => true,
      submit,
    });
    expect(controller.active?.fireCount).toBe(0);
    expect(controller.buildSystemPromptSuffix()).toContain('新任务');
    expect(controller.buildSystemPromptSuffix()).not.toContain('旧任务');
  });
});

describe('loop plugin', () => {
  it('registers /loop and injects loop guidance into the system prompt while active', async () => {
    const { hooks, registered, notices, submitted } = createHarness();
    const command = registered.get('loop')!;
    expect(command).toBeDefined();

    await command.action('60m 推送一个 BBC 的新闻');

    expect(notices.some((n) => n.includes('loop 已启动'))).toBe(true);
    expect(submitted).toHaveLength(1); // 启动即执行第一次

    const built = hooks.pipelineSync('system-prompt:build', { runtime: {}, prompt: 'BASE' });
    expect(built.prompt).toContain('定时循环任务');
    expect(built.prompt).toContain('推送一个 BBC 的新闻');
    expect(built.prompt.startsWith('BASE')).toBe(true);
  });

  it('stops the loop and removes the guidance', async () => {
    const { hooks, registered, notices } = createHarness();
    const command = registered.get('loop')!;

    await command.action('60m 推送新闻');
    await command.action('stop');

    expect(notices.some((n) => n.includes('loop 已停止'))).toBe(true);
    const built = hooks.pipelineSync('system-prompt:build', { runtime: {}, prompt: 'BASE' });
    expect(built.prompt).toBe('BASE');
  });

  it('shows status and error notices', async () => {
    const { registered, notices } = createHarness();
    const command = registered.get('loop')!;

    await command.action('');
    expect(notices.some((n) => n.includes('当前没有运行的定时循环任务'))).toBe(true);

    await command.action('abc 任务');
    expect(notices.some((n) => n.includes('无法解析循环间隔'))).toBe(true);
  });

  it('registers the loop adjustment tools for the primary agent', () => {
    const { registeredTools } = createHarness();
    expect(registeredTools.map((t) => t.name).sort()).toEqual([
      'loop_set_interval',
      'loop_set_task',
      'loop_status',
      'loop_stop',
    ]);
  });
});

type RegisteredCommand = { name: string; action(args?: string): Promise<unknown> };
type RegisteredTool = { name: string };

function createHarness() {
  const hooks = new micaPlugin.HookRegistry();
  const published: unknown[] = [];
  const notices: string[] = [];
  const submitted: Array<{ text: string; options?: unknown }> = [];
  const registeredTools: RegisteredTool[] = [];
  const services = {
    getCurrentAgentSessionId: () => 's1',
    isAgentBusy: () => false,
    submitAgentSessionInput: vi.fn(async (_id: string, text: string, options?: unknown) => {
      submitted.push({ text, options });
      return { ok: true };
    }),
    showNotice: (text: string) => notices.push(text),
  };
  const registered = new Map<string, RegisteredCommand>();
  const ctx = {
    pluginId: 'builtin.command.loop',
    hooks,
    services: {
      get: (token: unknown) =>
        token === commandHostToken
          ? {
              agent: {},
              sessionController: {},
              services,
              registerCommand: (_ctx: PluginContext, command: RegisteredCommand) => registered.set(command.name, command),
            }
          : undefined,
    },
    tools: {
      register: (tool: MicaTool) => {
        registeredTools.push({ name: tool.name });
        return { dispose: () => undefined };
      },
    },
    events: { publish: vi.fn((event: unknown) => published.push(event)) },
    onDispose: vi.fn(),
  } as unknown as PluginContext;

  setupLoop(ctx);
  return { hooks, registered, services, notices, submitted, published, registeredTools };
}
