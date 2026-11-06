import { describe, expect, it, vi } from 'vitest';
import { createPluginLlmApi, micaPlugin } from '@packages/mica-plugin/index.js';
import type { PluginContext, PluginSettingValues } from '@packages/mica-plugin/index.js';
import type { RuntimeTurnAfterHookEvent } from '@packages/mica-runtime/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import setup, { DEFAULT_PROMPT } from './index.js';

const reply = '完成了：' + ' 细节'.repeat(700);

describe('reply-digest plugin', () => {
  it('does not call the model for a short reply', async () => {
    const harness = createHarness();

    await harness.emitAfter([{ role: 'user', content: 'request' }, { role: 'assistant', content: '短回复' }]);

    expect(harness.query).not.toHaveBeenCalled();
    expect(harness.notices).toEqual([]);
  });

  it('summarizes a long reply and keeps the notice on the event owner', async () => {
    const harness = createHarness();

    await harness.emitAfter([{ role: 'user', content: 'request' }, { role: 'assistant', content: reply }]);
    await vi.waitFor(() => expect(harness.query).toHaveBeenCalledOnce());

    expect(harness.request.user).toContain('Agent 最终回复：');
    expect(harness.request.owner).toBe(harness.owner);
    expect(harness.notices).toEqual([
      {
        content: '长回复摘要\n\n已完成实现并通过验证。',
        options: expect.objectContaining({ owner: harness.owner, variant: 'compact' }),
      },
    ]);
  });

  it('does not summarize aborted or one-shot turns', async () => {
    const harness = createHarness();

    await harness.emitAfter([{ role: 'user', content: 'request' }, { role: 'assistant', content: reply }], 'aborted');
    await harness.emitAfter(
      [{ role: 'user', content: 'request' }, { role: 'assistant', content: reply }],
      'completed',
      'one-shot',
    );

    expect(harness.query).not.toHaveBeenCalled();
  });

  it('does not break when the model fails', async () => {
    const harness = createHarness({ fail: true });

    await expect(
      harness.emitAfter([{ role: 'user', content: 'request' }, { role: 'assistant', content: reply }]),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => expect(harness.logger.warn).toHaveBeenCalledWith('reply-digest:failed', expect.anything()));

    expect(harness.notices).toEqual([]);
  });

  it('summarizes the same turn only once', async () => {
    const harness = createHarness();

    await harness.emitAfter([{ role: 'user', content: 'request' }, { role: 'assistant', content: reply }]);
    await vi.waitFor(() => expect(harness.notices).toHaveLength(1));
    await harness.emitAfter([{ role: 'user', content: 'request' }, { role: 'assistant', content: reply }]);

    await expect.poll(() => harness.notices.length).toBe(1);
    expect(harness.query).toHaveBeenCalledOnce();
  });

  it('summarizes again on a new turn', async () => {
    const harness = createHarness();

    await harness.emitAfter(
      [{ role: 'user', content: 'request' }, { role: 'assistant', content: reply }],
      'completed',
      'session',
      'input-1',
    );
    await vi.waitFor(() => expect(harness.notices).toHaveLength(1));
    await harness.emitAfter(
      [{ role: 'user', content: 'request' }, { role: 'assistant', content: reply }],
      'completed',
      'session',
      'input-2',
    );

    await expect.poll(() => harness.notices.length).toBe(2);
    expect(harness.query).toHaveBeenCalledTimes(2);
  });
});

function createHarness(options: { fail?: boolean } = {}) {
  const hooks = new micaPlugin.HookRegistry();
  const owner = {};
  const request = { user: '', owner: undefined as unknown };
  const notices: Array<{ content: string; options: Record<string, unknown> }> = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const query = options.fail
    ? vi.fn(async () => {
        throw new Error('provider unavailable');
      })
    : vi.fn(async () => ({ text: '已完成实现并通过验证。', usage: null }));
  const settings: PluginSettingValues = {
    charThreshold: '1800',
    lineThreshold: '36',
    inputLimit: '12000',
    summaryLimit: '600',
    prompt: DEFAULT_PROMPT,
  };
  const ctx = {
    pluginId: 'reply-digest',
    hooks,
    services: new micaPlugin.ServiceContainer(),
    settings: { path: null, get: () => settings, validate: () => [] },
    session: {
      describe: () => ({ id: 'session-1', title: 'test' }),
      messages: () => currentMessages,
    },
    agent: { mode: 'session' },
    llm: createPluginLlmApi({
      spec: {},
      readValues: () => ({ useMainProvider: 'false', baseUrl: 'https://example.test/v1', model: 'mini' }),
      models: async (input) => {
        request.user = input.user;
        request.owner = input.owner;
        return query();
      },
    }),
    ui: {
      notice: (content: string, options: Record<string, unknown>) => notices.push({ content, options }),
    },
    health: { path: null, read: () => null, report: vi.fn(), clear: vi.fn() },
    logger,
    onDispose: (handler: () => void) => {
      void handler;
    },
  } as unknown as PluginContext;
  let currentMessages: MicaUiConversationMessage[] = [];
  setup(ctx);

  return {
    owner,
    request,
    notices,
    logger,
    query,
    async emitAfter(
      messages: MicaUiConversationMessage[],
      outcome: RuntimeTurnAfterHookEvent['outcome'] = 'completed',
      mode = 'session',
      inputId = 'input-1',
    ) {
      currentMessages = messages;
      (ctx.agent as { mode: string }).mode = mode;
      await hooks.emit<RuntimeTurnAfterHookEvent>('turn:after', {
        input: { id: inputId, text: 'request', source: 'ui', createdAt: 0 },
        elapsedMs: 10,
        hasError: outcome !== 'completed',
        outcome,
        owner,
      });
    },
  };
}
