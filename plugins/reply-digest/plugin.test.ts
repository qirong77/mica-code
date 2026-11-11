import { describe, expect, it, vi } from 'vitest';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import type { PluginContext, PluginNoticeOptions, PluginSettingValues } from '@packages/mica-plugin/index.js';
import type { RuntimeTurnAfterHookEvent, RuntimeTurnBeforeHookEvent } from '@packages/mica-runtime/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import setup, { DEFAULT_PROMPT } from './index.js';

const reply = '完成了：' + ' 细节'.repeat(700);
const longMessages: MicaUiConversationMessage[] = [
  { role: 'user', content: 'request' },
  { role: 'assistant', content: reply },
];
const summary = '**已完成实现**\n\n- 通过验证。';
const result = (text = summary) => ({ text, usage: null });

function deferred() {
  let resolve!: (value: ReturnType<typeof result>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<ReturnType<typeof result>>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// 摘要后台 promise 链只包含微任务，不用真实计时或长轮询。
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('reply-digest plugin', () => {
  it('does not call the model for a short reply', async () => {
    const harness = createHarness();
    await harness.emitAfter([{ role: 'assistant', content: '短回复' }]);
    expect(harness.query).not.toHaveBeenCalled();
    expect(harness.notices).toEqual([]);
  });

  it('does not summarize an old long reply after a completed turn without assistant text', async () => {
    const harness = createHarness();
    await harness.emitAfter([
      ...longMessages,
      { role: 'user', content: 'new request' },
      { role: 'notice', content: 'completed tool activity' },
    ]);
    expect(harness.query).not.toHaveBeenCalled();
    expect(harness.notices).toEqual([]);
  });

  it('shows running before the pending request completes and replaces it with the summary', async () => {
    const pending = deferred();
    const harness = createHarness();
    harness.query.mockImplementationOnce(() => {
      expect(harness.visible().map((entry) => entry.options.status)).toEqual(['running']);
      return pending.promise;
    });
    await harness.emitAfter();
    expect(harness.query).toHaveBeenCalledOnce();
    expect(harness.visible()).toEqual([
      {
        content: expect.stringContaining('正在整理'),
        options: { owner: harness.owner, command: 'reply-digest:input-1', variant: 'digest', status: 'running' },
      },
    ]);
    expect(harness.query.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        user: expect.stringContaining('Agent 最终回复：'),
        owner: harness.owner,
        signal: expect.any(AbortSignal),
      }),
    );

    pending.resolve(result());
    await flush();
    expect(harness.visible()).toEqual([
      {
        content: summary,
        options: { owner: harness.owner, command: 'reply-digest:input-1', variant: 'digest', status: 'info' },
      },
    ]);
    expect(harness.health.report).toHaveBeenCalledWith({ level: 'ok', message: '长回复摘要已生成' });
  });

  it('does not summarize aborted, failed or one-shot turns', async () => {
    const harness = createHarness();
    await harness.emitAfter(longMessages, 'aborted');
    await harness.emitAfter(longMessages, 'error');
    await harness.emitAfter(longMessages, 'completed', 'one-shot');
    expect(harness.query).not.toHaveBeenCalled();
    expect(harness.notices).toEqual([]);
  });

  it.each(['failure', 'empty', 'cancelled'] as const)('stops the running card after a %s response', async (kind) => {
    const pending = deferred();
    const harness = createHarness();
    harness.query.mockReturnValueOnce(pending.promise);
    await harness.emitAfter();
    if (kind === 'empty') pending.resolve(result('  '));
    else
      pending.reject(
        kind === 'cancelled' ? new DOMException('cancelled', 'AbortError') : new Error('provider unavailable'),
      );
    await flush();
    expect(harness.visible()).toEqual([
      {
        content: expect.stringContaining('原回复不受影响'),
        options: expect.objectContaining({ owner: harness.owner, status: 'warning', command: 'reply-digest:input-1' }),
      },
    ]);
    expect(harness.logger.warn).toHaveBeenCalledWith('reply-digest:failed', expect.anything());
    expect(harness.health.report).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }));
  });

  it('stops the pending card on an aborted turn and ignores its late result', async () => {
    const pending = deferred();
    const harness = createHarness();
    harness.query.mockReturnValueOnce(pending.promise);
    await harness.emitAfter();
    await harness.emitAfter(longMessages, 'aborted');
    expect(harness.visible()[0]?.options.status).toBe('warning');
    expect(harness.query.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    pending.resolve(result());
    await flush();
    expect(harness.notices).toHaveLength(2);
    expect(harness.visible()[0]?.options.status).toBe('warning');
  });

  it('stops immediately on disposal even when the provider ignores abort', async () => {
    const pending = deferred();
    const harness = createHarness();
    harness.query.mockReturnValueOnce(pending.promise);
    await harness.emitAfter();
    harness.dispose();
    expect(harness.query.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(harness.visible()[0]?.options.status).toBe('warning');
    expect(harness.visible()[0]?.content).toContain('插件已停用');
    const noticeCount = harness.notices.length;
    pending.resolve(result('迟到的摘要'));
    await flush();
    await harness.emitAfter(longMessages, 'completed', 'session', 'input-2');
    expect(harness.notices).toHaveLength(noticeCount);
    expect(harness.query).toHaveBeenCalledOnce();
  });

  it('ignores duplicate events both while pending and after completion', async () => {
    const pending = deferred();
    const harness = createHarness();
    harness.query.mockReturnValueOnce(pending.promise);
    await harness.emitAfter();
    await harness.emitAfter();
    expect(harness.notices).toHaveLength(1);
    expect(harness.query.mock.calls[0]?.[0].signal?.aborted).toBe(false);
    pending.resolve(result());
    await flush();
    await harness.emitAfter();
    expect(harness.notices).toHaveLength(2);
    expect(harness.query).toHaveBeenCalledOnce();
  });

  it('keeps summaries for each turn and ignores a duplicate older turn', async () => {
    const harness = createHarness();
    await harness.emitAfter();
    await flush();
    await harness.emitAfter(longMessages, 'completed', 'session', 'input-2');
    await flush();
    await harness.emitAfter();
    expect(harness.visible().map((entry) => entry.options.command)).toEqual([
      'reply-digest:input-1',
      'reply-digest:input-2',
    ]);
    expect(harness.visible().every((entry) => entry.options.status === 'info')).toBe(true);
    expect(harness.query).toHaveBeenCalledTimes(2);
  });

  it.each(['resolve', 'reject'] as const)(
    'cancels an older request before starting the next and ignores late %s',
    async (late) => {
      const old = deferred();
      const next = deferred();
      const harness = createHarness();
      harness.query.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
      await harness.emitAfter();
      await harness.emitAfter(longMessages, 'completed', 'session', 'input-2');
      expect(harness.query.mock.calls[0]?.[0].signal?.aborted).toBe(true);
      expect(harness.visible().map((entry) => entry.options.status)).toEqual(['warning', 'running']);
      if (late === 'resolve') old.resolve(result('旧结果'));
      else old.reject(new Error('旧请求错误'));
      await flush();
      expect(harness.visible().map((entry) => entry.options.status)).toEqual(['warning', 'running']);
      expect(harness.logger.warn).not.toHaveBeenCalled();
      next.resolve(result('新结果'));
      await flush();
      expect(harness.visible().map((entry) => entry.content)).toEqual([expect.stringContaining('已取消'), '新结果']);
    },
  );

  it('stops the previous spinner as soon as a new turn starts, even if its reply is short', async () => {
    const pending = deferred();
    const harness = createHarness();
    harness.query.mockReturnValueOnce(pending.promise);
    await harness.emitAfter();
    await harness.emitBefore('input-2');
    expect(harness.visible()[0]?.options.status).toBe('warning');
    expect(harness.query.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    await harness.emitAfter([{ role: 'assistant', content: '短回复' }], 'completed', 'session', 'input-2');
    pending.resolve(result());
    await flush();
    expect(harness.query).toHaveBeenCalledOnce();
    expect(harness.visible()).toHaveLength(1);
    expect(harness.visible()[0]?.options.status).toBe('warning');
  });

  it('isolates concurrent owners even for the same input id', async () => {
    const first = deferred();
    const second = deferred();
    const harness = createHarness();
    harness.query.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await harness.emitAfter();
    await harness.emitAfter(longMessages, 'completed', 'session', 'input-1', harness.otherOwner);
    expect(harness.query.mock.calls[0]?.[0].signal?.aborted).toBe(false);
    expect(harness.visible(harness.owner)[0]?.options.status).toBe('running');
    expect(harness.visible(harness.otherOwner)[0]?.options.status).toBe('running');
    second.resolve(result('会话二摘要'));
    first.resolve(result('会话一摘要'));
    await flush();
    expect(harness.visible(harness.owner)[0]?.content).toBe('会话一摘要');
    expect(harness.visible(harness.otherOwner)[0]?.content).toBe('会话二摘要');
  });

  it('does not write a late summary when the owner now describes a different session', async () => {
    const pending = deferred();
    const harness = createHarness();
    harness.query.mockReturnValueOnce(pending.promise);
    await harness.emitAfter();
    harness.sessions.set(harness.owner, 'resumed-session');
    pending.resolve(result('旧会话结果'));
    await flush();
    expect(harness.notices).toHaveLength(1);
  });
});

function createHarness() {
  const hooks = new micaPlugin.HookRegistry();
  const owner = {};
  const otherOwner = {};
  const sessions = new Map<object, string>([
    [owner, 'session-1'],
    [otherOwner, 'session-2'],
  ]);
  const notices: Array<{ content: string; options: PluginNoticeOptions }> = [];
  const displayed = new Map<unknown, typeof notices>();
  const disposers: Array<() => void> = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  type Request = Parameters<NonNullable<PluginContext['llm']>['request']>[0];
  const query = vi.fn(async (_request: Request) => result());
  const settings: PluginSettingValues = {
    charThreshold: '1800',
    lineThreshold: '36',
    inputLimit: '12000',
    summaryLimit: '600',
    prompt: DEFAULT_PROMPT,
  };
  const health = { path: null, read: () => null, report: vi.fn(), clear: vi.fn() };
  const ctx = {
    pluginId: 'reply-digest',
    hooks,
    services: new micaPlugin.ServiceContainer(),
    settings: { path: null, get: () => settings, validate: () => [] },
    session: {
      describe: (target: object) => (sessions.has(target) ? { id: sessions.get(target), title: 'test' } : null),
      messages: () => currentMessages,
    },
    agent: { mode: 'session' },
    llm: { configured: () => true, request: query },
    ui: {
      notice: (content: string, options: PluginNoticeOptions) => {
        const entry = { content, options };
        notices.push(entry);
        const messages = displayed.get(options.owner) ?? [];
        // Match the host's default command upsert: replace only a running card, in place.
        const index = messages.findIndex(
          (item) => item.options.command === options.command && item.options.status === 'running',
        );
        if (index < 0) messages.push(entry);
        else messages[index] = entry;
        displayed.set(options.owner, messages);
      },
    },
    health,
    logger,
    onDispose: (handler: () => void) => disposers.push(handler),
  } as unknown as PluginContext;
  let currentMessages: MicaUiConversationMessage[] = [];
  setup(ctx);

  return {
    owner,
    otherOwner,
    sessions,
    notices,
    logger,
    query,
    health,
    visible: (target: object = owner) => displayed.get(target) ?? [],
    dispose: () => disposers.forEach((handler) => handler()),
    async emitBefore(inputId: string, target = owner) {
      await hooks.emit<RuntimeTurnBeforeHookEvent>('turn:before', {
        runtime: {},
        owner: target,
        input: { id: inputId, text: 'request', source: 'ui', createdAt: 0 },
      });
    },
    async emitAfter(
      messages = longMessages,
      outcome: RuntimeTurnAfterHookEvent['outcome'] = 'completed',
      mode = 'session',
      inputId = 'input-1',
      target = owner,
    ) {
      currentMessages = messages;
      (ctx.agent as { mode: string }).mode = mode;
      await hooks.emit<RuntimeTurnAfterHookEvent>('turn:after', {
        input: { id: inputId, text: 'request', source: 'ui', createdAt: 0 },
        elapsedMs: 10,
        hasError: outcome !== 'completed',
        outcome,
        owner: target,
      });
    },
  };
}
