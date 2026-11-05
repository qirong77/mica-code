import { describe, expect, it } from 'vitest';
import type { PluginContext, PluginIdleCompactOptions, PluginIdleCompactOutcome, PluginTurnPrepareEvent } from '@packages/mica-plugin/index.js';
import setup from './index.js';

type Harness = {
  run: (action: string) => Promise<{ message?: string } | void>;
  calls: PluginIdleCompactOptions[];
  requests: Array<{ purpose: string; system: string; user: string }>;
  prepare: (event: PluginTurnPrepareEvent) => Promise<void>;
};

const applied = (beforeTokens = 806_000, afterTokens = 46_000): PluginIdleCompactOutcome => ({
  status: 'applied',
  beforeTokens,
  afterTokens,
  savedTokens: beforeTokens - afterTokens,
});

function createHarness(
  outcome: PluginIdleCompactOutcome | Error,
  options: { summary?: string; configured?: boolean } = {},
): Harness {
  const calls: PluginIdleCompactOptions[] = [];
  const requests: Harness['requests'] = [];
  let prepare: Harness['prepare'] = async () => {};
  let handler: { run: (input: { action: string }) => ReturnType<Harness['run']> } = {
    run: async () => ({ message: '未注册' }),
  };
  setup({
    pluginId: 'session-compact',
    health: { report: () => undefined },
    hooks: { on: (_name: string, handler: Harness['prepare']) => { prepare = handler; return { dispose() {} }; } },
    onDispose: () => {},
    desktop: {
      sessionMenu: (value: typeof handler) => {
        handler = value;
      },
    },
    agent: {
      compactIdleHistory: async (options: PluginIdleCompactOptions) => {
        calls.push(options);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    },
    llm: {
      configured: () => options.configured !== false,
      request: async (request: { purpose: string; system: string; user: string }) => {
        requests.push(request);
        return { text: options.summary ?? '## 摘要' };
      },
    },
  } as unknown as PluginContext);
  return { run: (action) => handler.run({ action }), calls, requests, prepare: (event) => prepare(event) };
}

describe('session compaction menu', () => {
  it('quickly compacts only after an effective model configuration change', async () => {
    const harness = createHarness(applied());
    const calls: PluginIdleCompactOptions[] = [];
    const config = { providerId: 'p', model: 'a', effort: 'low' };
    const compactHistory = async (options?: { mode?: 'quick' }) => {
      calls.push(options ?? {});
      return applied();
    };
    await harness.prepare({ previous: config, current: { ...config }, compactHistory });
    expect(calls).toEqual([]);
    await harness.prepare({ previous: config, current: { ...config, effort: 'high' }, compactHistory });
    for (const current of [{ ...config, model: 'b' }, { ...config, providerId: 'q' }]) {
      await harness.prepare({ previous: config, current, compactHistory });
    }
    expect(calls).toEqual([{ mode: 'quick' }, { mode: 'quick' }]);
  });
  it('quick compaction only replaces tool results', async () => {
    const harness = createHarness(applied());

    const result = await harness.run('quick');

    // 快速压缩就是本地清理：既不传摘要请求，也不惊动模型。
    expect(harness.calls).toEqual([{ mode: 'quick' }]);
    expect(harness.requests).toEqual([]);
    expect(result?.message).toBe('快速压缩完成：806K → 约 46K（清掉 760K）');
  });

  it('model compaction sends the dialogue through the plugin llm', async () => {
    const harness = createHarness(applied());

    const result = await harness.run('model');

    expect(harness.calls.map((call) => call.mode)).toEqual(['model']);
    const summarize = harness.calls[0]!.summarize!;
    await expect(summarize('用户：看看构建为什么慢', '写一段摘要')).resolves.toBe('## 摘要');
    expect(harness.requests[0]).toMatchObject({
      purpose: '会话压缩摘要',
      system: '写一段摘要',
      user: '用户：看看构建为什么慢',
    });
    expect(result?.message).toBe('模型压缩完成：806K → 约 46K（清掉 760K）');
  });

  it('reports why nothing happened instead of failing silently', async () => {
    expect(await createHarness({ status: 'skipped', reason: 'busy' }).run('quick')).toEqual({
      message: '这条会话正忙，等这一轮结束再压',
    });
    expect(await createHarness({ status: 'skipped', reason: 'empty' }).run('quick')).toEqual({
      message: '没有可清理的工具结果',
    });
    expect(await createHarness({ status: 'skipped', reason: 'empty' }).run('model')).toEqual({
      message: '对话内容太少，不用压缩',
    });
  });

  it('does not call the model when the summarization model is unconfigured', async () => {
    const harness = createHarness(applied(), { configured: false });

    expect(await harness.run('model')).toEqual({
      message: '压缩摘要模型未配置：在插件设置里复用当前会话模型，或填写接口地址与模型',
    });
    expect(harness.calls).toEqual([]);
  });

  it('turns a host failure into a readable menu message', async () => {
    expect(await createHarness(new Error('摘要请求超时')).run('model')).toEqual({
      message: '模型压缩失败：摘要请求超时',
    });
  });

  it('ignores unknown actions', async () => {
    const harness = createHarness(applied());

    expect(await harness.run('compact-everything')).toEqual({ message: '未知动作：compact-everything' });
    expect(harness.calls).toEqual([]);
  });
});
