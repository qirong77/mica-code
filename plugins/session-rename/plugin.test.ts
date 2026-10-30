import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPluginLlmApi, micaPlugin } from '@packages/mica-plugin/index.js';
import type { PluginContext, PluginSessionInfo, PluginSettingValues } from '@packages/mica-plugin/index.js';
import type { RuntimeInputSource, RuntimeTurnBeforeHookEvent } from '@packages/mica-runtime/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';

const query = vi.fn(async (_transcript: string) => '标题：修复登录超时\n说明：给 fetch 加了 timeout');

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
  it('renames the session with an auto-sourced title before the turn runs', async () => {
    const harness = createHarness();

    await harness.emitTurnBefore();
    const renamed = await harness.renamed;

    expect(renamed).toEqual({ title: '修复登录超时', source: 'auto' });
    expect(query).toHaveBeenCalledOnce();
    expect(String((query.mock.calls[0] as unknown[])[0])).toContain('用户：登录老是超时');
  });

  it('starts the title request without holding the turn open', async () => {
    const harness = createHarness();
    let releaseQuery: (title: string) => void = () => {};
    query.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseQuery = resolve;
        }),
    );

    // handler 必须同步返回：turn:before 是 await 的，等一次外部请求就是每轮都卡 1-2 秒。
    await expect(harness.emitTurnBefore()).resolves.toBeUndefined();
    expect(harness.renameCalls).toEqual([]);

    releaseQuery('修复登录超时');
    await vi.waitFor(() => expect(harness.renameCalls).toHaveLength(1));
  });

  it('puts the newest request after the context so the title follows the current task', async () => {
    const harness = createHarness({
      messages: [
        { role: 'user', content: '重构压缩策略' },
        { role: 'assistant', content: '把阈值挪进 CompactionService 了' },
      ],
    });

    await harness.emitTurnBefore({ text: '顺便把登录超时也修了' });
    await harness.renamed;

    const prompt = String((query.mock.calls.at(-1) as unknown[])[0]);
    expect(prompt).toContain('对话记录（从旧到新，仅用于理解上下文）：');
    expect(prompt).toContain('用户：重构压缩策略');
    expect(prompt).toContain('用户最新请求（标题概括这一段）：\n用户：顺便把登录超时也修了');
    // 本轮输入只出现一次：TUI 里它已经进了 uiState，headless 里还没进 agent history。
    expect(prompt.match(/顺便把登录超时也修了/g)).toHaveLength(1);
  });

  it('never sends tool noise: the transcript is text messages only', async () => {
    const harness = createHarness({
      messages: [
        { role: 'user', content: '跑下测试' },
        { role: 'assistant', content: '跑完了，两个用例挂了' },
      ],
    });

    await harness.emitTurnBefore({ text: '那修一下' });
    await harness.renamed;

    const prompt = String((query.mock.calls.at(-1) as unknown[])[0]);
    expect(prompt).not.toContain('run_shell');
    expect(prompt).toContain('助手：跑完了');
  });

  it('respects a title the user renamed by hand', async () => {
    const harness = createHarness({ titleSource: 'manual' });

    await harness.emitTurnBefore();

    expect(harness.renameCalls).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('ignores system inputs, which carry no user request', async () => {
    const harness = createHarness();

    await harness.emitTurnBefore({ text: '[Mica compact boundary]\n{}', source: 'system' });

    expect(query).not.toHaveBeenCalled();
  });

  it('stays silent when the endpoint is not configured yet', async () => {
    const harness = createHarness({ settings: { ...configuredSettings, baseUrl: '', model: '' } });

    await harness.emitTurnBefore();

    expect(query).not.toHaveBeenCalled();
    expect(harness.renameCalls).toEqual([]);
  });

  it('swallows request failures instead of breaking the turn', async () => {
    const harness = createHarness();
    // 持续失败：`ctx.llm` 会用主配置再试一次，两次都失败才走插件的失败分支。
    query.mockRejectedValue(new Error('401 invalid key'));

    await expect(harness.emitTurnBefore()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(harness.logger.warn).toHaveBeenCalled());

    expect(harness.renameCalls).toEqual([]);
  });

  it('does not write a title that did not change', async () => {
    const harness = createHarness({ title: '修复登录超时' });
    query.mockResolvedValueOnce('修复登录超时');

    await harness.emitTurnBefore();
    await vi.waitFor(() =>
      expect(harness.logger.info).toHaveBeenCalledWith('session-rename:unchanged', expect.anything()),
    );

    expect(harness.renameCalls).toEqual([]);
  });

  it('asks once per user request, not again for the trailing turn:before of one-shot hosts', async () => {
    const harness = createHarness();

    await harness.emitTurnBefore();
    await vi.waitFor(() => expect(harness.renameCalls).toHaveLength(1));
    await harness.flush();

    await harness.emitTurnBefore();
    await harness.flush();

    expect(query).toHaveBeenCalledOnce();
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
    // 真组件 + 假底层：插件走的就是 `ctx.llm` 这条路。
    llm: createPluginLlmApi({
      spec: {},
      readValues: () => options.settings ?? configuredSettings,
      models: async (request) => ({ text: await query(request.user), usage: null }),
    }),
    onDispose: (handler: () => void) => disposeHandlers.push(handler),
  } as unknown as PluginContext;

  setup(ctx);

  return {
    logger,
    healthReports,
    renameCalls,
    renamed,
    /**
     * 派发一次 `turn:before`。
     *
     * handler 是同步返回的（改名只是发起），所以这里 resolve 时请求多半还没回来；
     * 要等结果用 `renamed` 或 `vi.waitFor`。
     */
    async emitTurnBefore(options: { text?: string; source?: RuntimeInputSource } = {}) {
      await hooks.emit<RuntimeTurnBeforeHookEvent>('turn:before', {
        runtime: {},
        input: {
          id: 'input-1',
          text: options.text ?? '登录老是超时',
          source: options.source ?? 'ui',
          createdAt: 0,
        },
      });
    },
    /** 把已排队的 microtask（rename 链）全部跑完。 */
    flush: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
}
