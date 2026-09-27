import { describe, expect, it, vi } from 'vitest';
import mitt from 'mitt';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import { HeadlessTurnExecutor } from '../runtime/HeadlessTurnExecutor.js';
import { createHeadlessPluginHost, startAsSubmit } from './HeadlessPluginHost.js';

function mockAgent(overrides: Record<string, unknown> = {}): AgentRuntime {
  return {
    events: mitt(),
    config: { provider: { id: 'test-provider', contextWindowSize: 1_000_000 }, model: 'test-model', effort: 'medium' },
    getSnapshot: () => ({
      providerId: 'test-provider',
      model: 'test-model',
      effort: 'medium',
      role: 'default',
      messages: [],
      usageHistory: [],
      lastUsage: undefined,
    }),
    toConversationMessages: () => [],
    captureClientSnapshot: () => null,
    restoreClientSnapshot: () => {},
    clearSession: () => {},
    reserveRunId: () => 1,
    isCurrent: () => true,
    run: async () => ({ runId: 1, text: 'ok' }),
    abort: () => {},
    preserveAbortedTurn: () => true,
    ...overrides,
  } as unknown as AgentRuntime;
}

function mockSessionController(saveSpy: ReturnType<typeof vi.fn>): SessionController {
  return {
    getCurrentSessionId: () => 'sess-headless',
    saveCurrent: saveSpy,
    refreshFromStore: () => null,
    startNewSession: () => {},
    renameCurrent: () => {},
    list: () => [],
    listRecent: () => [],
    load: () => null,
    resume: () => ({ ok: false, message: 'n/a' }),
  } as unknown as SessionController;
}

async function mount(saveSpy = vi.fn(() => true), agentOverrides: Record<string, unknown> = {}) {
  const hooks = new micaPlugin.HookRegistry();
  const agent = mockAgent(agentOverrides);
  const sessionController = mockSessionController(saveSpy);
  const subagentTasks = { killForOwner: () => 0, list: () => [], stop: async () => {} };
  const executor = new HeadlessTurnExecutor({
    agent,
    sessionController,
    onEvent: () => {},
    parseImageRefs: (text: string) => Promise.resolve(text),
  });
  const host = createHeadlessPluginHost({
    hooks,
    agent,
    sessionController,
    subagentTasks: subagentTasks as never,
    isBusy: () => executor.isBusy,
    submit: (text, options) => startAsSubmit((input) => executor.start(input), text, options),
  });
  executor.attachPluginLayer({
    hooks: host.hooks,
    host,
    queue: host.queue,
    getConversationMessages: host.getConversationMessages,
  });
  await host.emitRuntimeStart();
  return { agent, executor, host, hooks };
}

function toolNames(): string[] {
  return micaTools.getDefinitions().map((tool) => tool.name);
}

describe('HeadlessPluginHost (headless === TUI plugin surface)', () => {
  it('registers the session-autonomy tools and TodoWrite', async () => {
    const { host } = await mount();
    const names = toolNames();
    for (const expected of ['session_info', 'session_compact', 'TodoWrite']) {
      expect(names).toContain(expected);
    }
    await host.dispose();
  });

  it('injects the session-autonomy guidance into the system prompt (system-prompt:build hook)', async () => {
    const { hooks, host } = await mount();
    const agent = host as unknown as { hooks: typeof hooks };
    const result = agent.hooks.pipelineSync('system-prompt:build', { runtime: {}, prompt: 'BASE' });
    expect(result.prompt).toContain('会话自治');
    expect(result.prompt).toContain('session_compact');
    expect(result.prompt).toContain('BASE');
    await host.dispose();
  });

  it('fires turn:before / prompt:build / turn:after in order around a turn', async () => {
    const { executor, hooks, host } = await mount();
    const order: string[] = [];
    const before = hooks.on('turn:before', () => order.push('turn:before'), { pluginId: 'test' });
    const prompt = hooks.on('prompt:build', () => order.push('prompt:build'), { pluginId: 'test' });
    const after = hooks.on('turn:after', () => order.push('turn:after'), { pluginId: 'test' });

    const result = await executor.start(micaRuntime.createRuntimeInput('hello', 'ui'));
    expect(result).toBe('started');
    await waitFor(() => !executor.isBusy);
    expect(order).toEqual(['turn:before', 'prompt:build', 'turn:after']);
    before.dispose();
    prompt.dispose();
    after.dispose();
    await host.dispose();
  });

  it('notices from session tools are persisted into conversationMessages', async () => {
    const saveSpy = vi.fn(() => true);
    const { host } = await mount(saveSpy);
    const commandHost = host.services.get(
      (await import('@packages/mica-builtin-commands/commandHost.js')).commandHostToken,
    );
    commandHost.services.showNotice('session_compact: 完成', 'sess-headless', {
      variant: 'compact',
      command: 'session_compact',
      status: 'success',
    });
    const lastCall = saveSpy.mock.calls.at(-1) as unknown[] | undefined;
    const saved = lastCall?.[0] as unknown as { conversationMessages?: Array<{ role: string; content: string }> };
    expect(saved.conversationMessages?.some((message) => message.role === 'notice')).toBe(true);
    expect(host.getConversationMessages()?.some((message) => message.role === 'notice')).toBe(true);
    await host.dispose();
  });

});

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 5000) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
