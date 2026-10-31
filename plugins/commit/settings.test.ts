import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMPT } from './message.js';
import { commitLlmProblem, readCommitSettings } from './settings.js';

describe('commit plugin settings', () => {
  it('fills defaults and keeps push on unless it is explicitly off', () => {
    const settings = readCommitSettings({});
    expect(settings.prompt).toBe(DEFAULT_PROMPT);
    expect(settings.push).toBe(true);
    expect(readCommitSettings({ push: 'false' }).push).toBe(false);
  });

  it('keeps a custom prompt verbatim', () => {
    expect(readCommitSettings({ prompt: ' 写中文  ' }).prompt).toBe('写中文');
  });

  it('reports a readable reason when the model interface is missing', () => {
    expect(commitLlmProblem(undefined)).toContain('requires 里缺 llm');
  });

  it('reports a readable reason when the interface is not configured', () => {
    const llm = {
      configured: () => false,
    } as never;
    expect(commitLlmProblem(llm)).toBe('未配置模型接口：请在插件设置里复用当前会话模型，或填写接口地址与模型');
  });

  it('passes when the interface is configured', () => {
    expect(commitLlmProblem({ configured: () => true } as never)).toBeNull();
  });
});
