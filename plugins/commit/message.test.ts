import { describe, expect, it } from 'vitest';
import type { PluginModelRequest, PluginModelsApi } from '@packages/mica-plugin/index.js';
import { DEFAULT_PROMPT, requestCommitMessage, sanitizeCommitMessage } from './message.js';

const config = {
  baseUrl: 'https://api.example.test/v1',
  apiKey: 'test-key',
  protocol: 'openai_chat_completions' as const,
  model: 'mini',
  prompt: DEFAULT_PROMPT,
};

function fakeModels(reply: string | Error): { models: PluginModelsApi; calls: PluginModelRequest[] } {
  const calls: PluginModelRequest[] = [];
  return {
    calls,
    models: {
      async request(request) {
        calls.push(request);
        if (reply instanceof Error) throw reply;
        return { text: reply, usage: null };
      },
    },
  };
}

describe('commit message request', () => {
  it('asks the host for one non-streaming completion and sanitizes the text', async () => {
    const { models, calls } = fakeModels('```\nfix: 修复导入路径 🐛\n```');

    const message = await requestCommitMessage(models, config, 'Changed files:\n M README.md');

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
    const { models } = fakeModels(new Error('HTTP 401 · invalid api key'));

    await expect(requestCommitMessage(models, config, 'diff')).rejects.toThrow(/commit message 请求无法完成：HTTP 401/);
  });

  it('falls back to a generic subject when the model returns nothing usable', () => {
    expect(sanitizeCommitMessage('   \n\n```\n```\n')).toBe('chore: 更新项目文件 🔧');
  });
});
