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

  it('context-pressure injects a reminder from the context:changed event', async () => {
    const submitSpy = vi.fn();
    const saveSpy = vi.fn(() => true);
    const { host } = await mount(saveSpy);
    // Replace the plugin host submit bridge with a spy for this assertion.
    const commandHost = host.services.get(
      (await import('@packages/mica-builtin-commands/commandHost.js')).commandHostToken,
    );
    vi.spyOn(commandHost.services, 'submitAgentSessionInput').mockImplementation(async (id, text, options) => {
      submitSpy(id, text, options);
      return { ok: true };
    });
    host.events.publish({ type: 'context:changed', tokens: 800_000, windowSize: 1_000_000, owner: {} });
    await vi.waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
    const [sessionId, text, options] = submitSpy.mock.calls[0]!;
    expect(sessionId).toBe('sess-headless');
    expect(text).toContain('80%');
    expect(options).toMatchObject({ queueMode: 'after_iteration' });
    await host.dispose();
  });

  it('publishes context:changed when the agent reports usage', async () => {
    const agentEvents = mitt<Record<string, unknown>>();
    const { host } = await mount(vi.fn(() => true), { events: agentEvents });
    const seen: unknown[] = [];
    host.events.on('event', (event) => {
      seen.push(event);
    });
    (agentEvents as unknown as { emit: (name: string, payload: unknown) => void }).emit('usage', {
      totalTokens: 500_000,
    });
    expect(seen.some((event) => (event as { type?: string }).type === 'context:changed')).toBe(true);
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
