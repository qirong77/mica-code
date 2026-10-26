import { beforeEach, describe, expect, it, vi } from 'vitest';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import type { PluginContext, PluginSessionInfo, PluginSettingValues } from '@packages/mica-plugin/index.js';
import type { RuntimeTurnAfterHookEvent } from '@packages/mica-runtime/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';

const query = vi.fn(async () => '标题：修复登录超时\n说明：给 fetch 加了 timeout');

vi.mock('@packages/mica-agent/index.js', () => ({
  micaAgent: {
    createSubAgent: () => ({
      query,
      lastUsage: { promptTokens: 10, completionTokens: 4 },
    }),
  },
}));

const { default: setup } = await import('./index.js');

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue('标题：修复登录超时\n说明：给 fetch 加了 timeout');
});

const messages: MicaUiConversationMessage[] = [
  { role: 'user', content: '登录老是超时' },
  { role: 'assistant', content: '给 fetch 加了 timeout' },
];

const configuredSettings: PluginSettingValues = {
  baseUrl: 'https://example.test/v1',
  apiKey: 'secret',
  protocol: 'openai_chat_completions',
  model: 'mini',
  prompt: '',
  maxMessages: '12',
  minIntervalSeconds: '0',
};

describe('session-rename plugin', () => {
  it('renames the session with an auto-sourced title after a completed turn', async () => {
    const harness = createHarness();

    await harness.emitTurnAfter('completed');
    const renamed = await harness.renamed;

    expect(renamed).toEqual({ title: '修复登录超时', source: 'auto' });
    expect(query).toHaveBeenCalledOnce();
    expect(String((query.mock.calls[0] as unknown[])[0])).toContain('用户：登录老是超时');
  });

  it('never sends tool noise: the transcript is text messages only', async () => {
    const harness = createHarness({
      messages: [
        { role: 'user', content: '跑下测试' },
        { role: 'assistant', content: '跑完了，两个用例挂了' },
      ],
    });

    await harness.emitTurnAfter('completed');
    await harness.renamed;

    const prompt = String((query.mock.calls.at(-1) as unknown[])[0]);
    expect(prompt).not.toContain('run_shell');
    expect(prompt).toContain('助手：跑完了');
  });

  it('respects a title the user renamed by hand', async () => {
    const harness = createHarness({ titleSource: 'manual' });

    await harness.emitTurnAfter('completed');

    expect(harness.renameCalls).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('skips failed and aborted turns', async () => {
    const harness = createHarness();

    await harness.emitTurnAfter('aborted');
    await harness.emitTurnAfter('error');

    expect(query).not.toHaveBeenCalled();
  });

  it('stays silent when the endpoint is not configured yet', async () => {
    const harness = createHarness({ settings: { ...configuredSettings, baseUrl: '', model: '' } });

    await harness.emitTurnAfter('completed');

    expect(query).not.toHaveBeenCalled();
    expect(harness.renameCalls).toEqual([]);
  });

  it('swallows request failures instead of breaking the turn', async () => {
    const harness = createHarness();
    query.mockRejectedValueOnce(new Error('401 invalid key'));

    await expect(harness.emitTurnAfter('completed')).resolves.toBeUndefined();
    await vi.waitFor(() => expect(harness.logger.warn).toHaveBeenCalled());

    expect(harness.renameCalls).toEqual([]);
  });

  it('does not write a title that did not change', async () => {
    const harness = createHarness({ title: '修复登录超时' });
    query.mockResolvedValueOnce('修复登录超时');

    await harness.emitTurnAfter('completed');
    await vi.waitFor(() =>
      expect(harness.logger.info).toHaveBeenCalledWith('session-rename:unchanged', expect.anything()),
    );

    expect(harness.renameCalls).toEqual([]);
  });
});

type HarnessOptions = {
  settings?: PluginSettingValues;
  messages?: MicaUiConversationMessage[];
  titleSource?: PluginSessionInfo['titleSource'];
  title?: string;
};

function createHarness(options: HarnessOptions = {}) {
  const hooks = new micaPlugin.HookRegistry();
  const renameCalls: Array<{ title: string; source?: string }> = [];
  let resolveRenamed: (value: { title: string; source?: string } | null) => void = () => {};
  const renamed = new Promise<{ title: string; source?: string } | null>((resolve) => {
    resolveRenamed = resolve;
  });

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const healthReports: Array<{ level: string; message: string }> = [];
  const disposeHandlers: Array<() => void> = [];
  const session: PluginSessionInfo = {
    id: 'session-1',
    title: options.title ?? '旧标题',
    titleSource: options.titleSource ?? 'derived',
  };

  const ctx = {
    pluginId: 'session-rename',
    hooks,
    services: new micaPlugin.ServiceContainer(),
    commands: {
      register: (item: unknown) => {
        void item;
        return { dispose() {} };
      },
    },
    events: { on: () => ({ dispose() {} }) },
    settings: { path: '/tmp/plugin-settings/session-rename.json', get: () => options.settings ?? configuredSettings },
    session: {
      describe: () => session,
      messages: () => options.messages ?? messages,
      rename: (title: string, renameOptions?: { source?: 'auto' | 'manual' }) => {
        renameCalls.push({ title, source: renameOptions?.source });
        resolveRenamed({ title, source: renameOptions?.source });
        return true;
      },
    },
    // health 由 PluginManager 无条件注入，不是可选项；假的 ctx 也得给，否则失败分支会抛。
    health: {
      path: null,
      read: () => null,
      report: (report: { level: string; message: string }) => healthReports.push(report),
      clear() {},
    },
    logger,
    onDispose: (handler: () => void) => disposeHandlers.push(handler),
  } as unknown as PluginContext;

  setup(ctx);

  return {
    logger,
    healthReports,
    renameCalls,
    renamed,
    async emitTurnAfter(outcome: RuntimeTurnAfterHookEvent['outcome']) {
      await hooks.emit<RuntimeTurnAfterHookEvent>('turn:after', {
        input: { id: 'input-1', text: '登录老是超时', source: 'ui', createdAt: 0 },
        elapsedMs: 10,
        hasError: outcome === 'error',
        outcome,
        owner: {},
      });
    },
  };
}
