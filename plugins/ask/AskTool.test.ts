import { describe, expect, it, vi } from 'vitest';
import type { PluginAskAnswer, PluginAskApi, PluginAskQuestion } from '@packages/mica-plugin/index.js';
import { resolvePluginAskDisplay } from '@packages/mica-plugin/index.js';
import { AskUserTool } from './AskTool.js';

function stubAsk(answer: PluginAskAnswer) {
  const seen: PluginAskQuestion[] = [];
  const api: PluginAskApi = {
    request: async (question) => {
      seen.push(question);
      return answer;
    },
    post: () => {
      throw new Error('ask_user 只用阻塞提问');
    },
  };
  return { api, seen };
}

const question = {
  title: '先做哪个入口？',
  options: [
    { id: 'a', label: '方案 A', prompt: '先做转账入口' },
    { id: 'b', label: '方案 B' },
  ],
};

describe('AskUserTool', () => {
  it('turns a picked option into an instruction the model can act on', async () => {
    const { api, seen } = stubAsk({ optionIds: ['a'], cancelled: false, reason: 'answered' });
    const text = await new AskUserTool(api).execute(question);
    expect(seen[0].title).toBe('先做哪个入口？');
    expect(text).toContain('用户选择了「方案 A」');
    // 选项上的 prompt 变成「按这个选项继续」的指令段落。
    expect(text).toContain('先做转账入口');
  });

  it('lists every option when several were picked', async () => {
    const { api } = stubAsk({ optionIds: ['a', 'b'], cancelled: false, reason: 'answered' });
    const text = await new AskUserTool(api).execute({ ...question, multiple: true });
    expect(text).toContain('「方案 A」');
    expect(text).toContain('「方案 B」');
  });

  it('passes the free-text answer through', async () => {
    const { api } = stubAsk({
      optionIds: [],
      custom: '都不做，先补文档',
      cancelled: false,
      reason: 'answered',
    });
    const text = await new AskUserTool(api).execute(question);
    expect(text).toContain('用户的补充：都不做，先补文档');
  });

  it('never forwards a switch for the free-text field', async () => {
    const { api, seen } = stubAsk({ optionIds: ['a'], cancelled: false, reason: 'answered' });
    await new AskUserTool(api).execute(question);
    const legacy = (value: PluginAskQuestion) => value as unknown as Record<string, unknown>;
    expect(legacy(seen[0]!).allowCustom).toBeUndefined();
    // 老 schema 里的 `allowCustom` / `ui.input` 不再往下传：输入框没有开关。
    await new AskUserTool(api).execute({ ...question, allowCustom: false, ui: { input: false } });
    expect(legacy(seen[1]!).allowCustom).toBeUndefined();
    // `ui` 是整块透传的；`input: false` 传到显示层也不再生效（恒为 true）
    expect(resolvePluginAskDisplay(seen[1]).input).toBe(true);
  });

  it('tells the model not to re-ask after a cancellation', async () => {
    const { api } = stubAsk({ optionIds: [], cancelled: true, reason: 'timeout' });
    const text = await new AskUserTool(api).execute(question);
    expect(text).toContain('没有回应');
    expect(text).toContain('不要重复问同一个问题');
    expect(text).toContain('已超时');
    expect(text).toContain('实现第一版');
    expect(text).toContain('不要自动执行选项里的 command');
  });

  it('defaults to five minutes and reads the configured timeout for each question', async () => {
    const { api, seen } = stubAsk({ optionIds: ['b'], cancelled: false, reason: 'answered' });
    await new AskUserTool(api).execute(question);
    expect(seen[0].timeoutMs).toBe(300_000);

    let timeoutMs = 120_000;
    const tool = new AskUserTool(api, { getTimeoutMs: () => timeoutMs });
    await tool.execute(question);
    timeoutMs = 600_000;
    await tool.execute(question);
    expect(seen.slice(1).map((item) => item.timeoutMs)).toEqual([120_000, 600_000]);
  });

  it('keeps a positive per-call timeout and falls back for invalid values', async () => {
    const { api, seen } = stubAsk({ optionIds: ['b'], cancelled: false, reason: 'answered' });
    const tool = new AskUserTool(api, { getTimeoutMs: () => 120_000 });
    await tool.execute({ ...question, timeoutMs: 1000 });
    for (const timeoutMs of [null, '', 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await tool.execute({ ...question, timeoutMs });
    }
    expect(seen[0].timeoutMs).toBe(1000);
    expect(seen.slice(1).every((item) => item.timeoutMs === 120_000)).toBe(true);
    await new AskUserTool(api, { getTimeoutMs: () => Number.NaN }).execute(question);
    expect(seen.at(-1)?.timeoutMs).toBe(300_000);
  });

  it('notifies the captured owner on timeout without treating an option as selected', async () => {
    const { api } = stubAsk({ optionIds: ['a'], cancelled: true, reason: 'timeout' });
    const context = {};
    const owner = {};
    const captureOwner = vi.fn(() => owner);
    const onTimeout = vi.fn();
    const signal = new AbortController().signal;
    const request = vi.spyOn(api, 'request');
    const text = await new AskUserTool(api, { captureOwner, onTimeout }).execute(question, {
      context,
      signal,
    });
    expect(captureOwner).toHaveBeenCalledWith(context);
    expect(request).toHaveBeenCalledWith(expect.anything(), { signal });
    expect(onTimeout).toHaveBeenCalledWith(expect.stringContaining('等待回复已超时'), owner);
    expect(onTimeout).toHaveBeenCalledWith(expect.stringContaining('先按保守方案实现第一版'), owner);
    expect(text).not.toContain('先做转账入口');
    expect(text).toContain('不代表用户选择了任何选项或批准了任何操作');
    expect(text).not.toContain('用户选择了「方案 A」');
  });

  it.each(['cancelled', 'aborted'] as const)('does not report %s as a timeout', async (reason) => {
    const { api } = stubAsk({ optionIds: [], cancelled: true, reason });
    const onTimeout = vi.fn();
    const text = await new AskUserTool(api, { onTimeout }).execute(question);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(text).not.toContain('超时');
    expect(text).not.toContain('实现第一版');
  });

  it('does not issue a timeout notice after the user answers', async () => {
    const { api } = stubAsk({ optionIds: ['a'], cancelled: false, reason: 'answered' });
    const onTimeout = vi.fn();
    await new AskUserTool(api, { onTimeout }).execute(question);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('reports a broken question instead of throwing at the model', async () => {
    const api: PluginAskApi = {
      request: async () => {
        throw new Error('提问缺少 title');
      },
      post: () => {
        throw new Error('ask_user 只用阻塞提问');
      },
    };
    const text = await new AskUserTool(api).execute({ title: '' });
    expect(text).toContain('提问缺少 title');
  });

  it('shows the question in the tool row while it waits', () => {
    expect(
      new AskUserTool(stubAsk({ optionIds: [], cancelled: true, reason: 'aborted' }).api).onToolUseDisplayText(
        question,
      ),
    ).toBe('Asking: 先做哪个入口？');
  });
});
