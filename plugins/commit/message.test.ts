import { describe, expect, it } from 'vitest';
import { createPluginLlmApi, type PluginModelRequest } from '@packages/mica-plugin/index.js';
import { DEFAULT_PROMPT, requestCommitMessage, sanitizeCommitMessage } from './message.js';

const config = { prompt: DEFAULT_PROMPT };

/** 用真的 `ctx.llm` 组件，只把最底层的请求换成假的：这样测的是插件真正走的那条路。 */
function fakeLlm(reply: string | Error, values: Record<string, string> = {}) {
  const calls: PluginModelRequest[] = [];
  const llm = createPluginLlmApi({
    spec: {},
    readValues: () => ({
      useMainProvider: 'false',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'test-key',
      model: 'mini',
      ...values,
    }),
    models: async (request) => {
      calls.push(request);
      if (reply instanceof Error) throw reply;
      return { text: reply, usage: null };
    },
  });
  return { llm, calls };
}

describe('commit message request', () => {
  it('asks the host for one non-streaming completion and sanitizes the text', async () => {
    const { llm, calls } = fakeLlm('```\nfix: 修复导入路径 🐛\n```');

    const message = await requestCommitMessage(llm, config, 'Changed files:\n M README.md');

    expect(message).toBe('fix: 修复导入路径 🐛');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      purpose: '写提交说明',
      system: DEFAULT_PROMPT,
      model: 'mini',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'test-key',
      protocol: 'openai_chat_completions',
    });
    expect(calls[0]!.user).toContain('README.md');
  });

  it('wraps host failures with the plugin error type', async () => {
    const { llm } = fakeLlm(new Error('HTTP 401 · invalid api key'));

    await expect(requestCommitMessage(llm, config, 'diff')).rejects.toThrow(/commit message 请求无法完成：HTTP 401/);
  });

  it('falls back to a generic subject when the model returns nothing usable', () => {
    expect(sanitizeCommitMessage('   \n\n```\n```\n')).toBe('chore: 更新项目文件 🔧');
  });
});
