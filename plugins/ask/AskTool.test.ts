import { describe, expect, it } from 'bun:test';
import type { PluginAskAnswer, PluginAskApi, PluginAskQuestion } from '@packages/mica-plugin/index.js';
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
    const text = await new AskUserTool(api).execute({ ...question, allowCustom: true });
    expect(text).toContain('用户的补充：都不做，先补文档');
  });

  it('leaves the free-text field on by default and can be turned off', async () => {
    const { api, seen } = stubAsk({ optionIds: ['a'], cancelled: false, reason: 'answered' });
    await new AskUserTool(api).execute(question);
    expect(seen[0].allowCustom).toBeUndefined();
    await new AskUserTool(api).execute({ ...question, allowCustom: false });
    expect(seen[1].allowCustom).toBe(false);
  });

  it('tells the model not to re-ask after a cancellation', async () => {
    const { api } = stubAsk({ optionIds: [], cancelled: true, reason: 'timeout' });
    const text = await new AskUserTool(api).execute(question);
    expect(text).toContain('没有回应');
    expect(text).toContain('不要重复问同一个问题');
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
    expect(new AskUserTool(stubAsk({ optionIds: [], cancelled: true, reason: 'aborted' }).api).onToolUseDisplayText(question)).toBe(
      'Asking: 先做哪个入口？',
    );
  });
});
