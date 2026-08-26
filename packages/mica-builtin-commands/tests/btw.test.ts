import { describe, expect, it, vi } from 'vitest';
import {
  buildBtwSystemPrompt,
  createBtwCommand,
  formatBtwNotice,
  messagesToTranscript,
  parseBtwArgs,
  runBtw,
} from '../commands/btw.js';
import type { CommandAgent, CommandRuntimeServices } from '../services.js';

describe('parseBtwArgs', () => {
  it('parses a plain question', () => {
    expect(parseBtwArgs('这个方案可行吗')).toEqual({ question: '这个方案可行吗', isContinue: false });
  });

  it('parses a continue with a follow-up', () => {
    expect(parseBtwArgs('-continue 那具体怎么落地')).toEqual({ question: '那具体怎么落地', isContinue: true });
  });

  it('treats empty / continue-only as null', () => {
    expect(parseBtwArgs('')).toBeNull();
    expect(parseBtwArgs('   ')).toBeNull();
    expect(parseBtwArgs('-continue')).toBeNull();
  });
});

describe('messagesToTranscript', () => {
  it('lists user and assistant text in order, skipping tools/system', () => {
    const messages = [
      { role: 'system', content: 'ignore me' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: [{ type: 'text', text: '你好！' }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'raw' }] },
    ];
    const transcript = messagesToTranscript(messages);
    expect(transcript).toBe('用户：你好\n\n助手：你好！');
  });
});

describe('buildBtwSystemPrompt', () => {
  it('declares btw mode, carries the transcript, and tells the agent to ignore the main flow', () => {
    const prompt = buildBtwSystemPrompt('用户：你好');
    expect(prompt).toContain('btw');
    expect(prompt).toContain('用户：你好');
    expect(prompt).toContain('你不需要考虑或帮助主流程的实现');
  });
});

describe('formatBtwNotice', () => {
  it('shows the question, answer, and a -continue affordance', () => {
    const notice = formatBtwNotice('这个方案可行吗', '可行。');
    expect(notice).toContain('> 这个方案可行吗');
    expect(notice).toContain('可行。');
    expect(notice).toContain('/btw -continue');
  });
});

describe('createBtwCommand / runBtw', () => {
  it('emits a running notice then a success notice, reusing the subagent on -continue', async () => {
    const query = vi.fn(async () => '答案');
    const agent = makeAgent(query);
    const services = makeServices();

    const command = createBtwCommand(agent, services);
    expect(command.name).toBe('btw');

    await runBtw(agent, services, '这个方案可行吗');

    expect(query).toHaveBeenCalledWith('这个方案可行吗');
    expect(services.showNotice).toHaveBeenCalledWith('> 这个方案可行吗\n\n正在思考…', undefined, {
      command: '/btw',
      status: 'running',
    });
    expect(services.showNotice).toHaveBeenLastCalledWith(
      expect.stringContaining('> 这个方案可行吗'),
      undefined,
      { command: '/btw', status: 'success' },
    );

    await runBtw(agent, services, '-continue 那具体怎么落地');

    // the same subagent is reused, so query is called a second time on it
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith('那具体怎么落地');
    expect(services.showNotice).toHaveBeenLastCalledWith(
      expect.stringContaining('> 那具体怎么落地'),
      undefined,
      { command: '/btw', status: 'success' },
    );
  });

  it('falls back to a new thread and warns when continuing with no prior btw', async () => {
    const query = vi.fn(async () => '答案');
    const agent = makeAgent(query);
    const services = makeServices();

    await runBtw(agent, services, '-continue 没有前文');

    expect(services.showNotice).toHaveBeenCalledWith(
      '没有可延续的 btw 对话，将作为一条新问题处理',
      undefined,
      { command: '/btw', status: 'info' },
    );
    expect(query).toHaveBeenCalledWith('没有前文');
  });

  it('emits an error notice when the subagent throws', async () => {
    const query = vi.fn(async () => {
      throw new Error('boom');
    });
    const agent = makeAgent(query);
    const services = makeServices();

    await runBtw(agent, services, '问题');

    expect(services.showNotice).toHaveBeenLastCalledWith(
      expect.stringContaining('btw 出错：boom'),
      undefined,
      { command: '/btw', status: 'error' },
    );
  });
});

function makeAgent(query: () => Promise<string>): CommandAgent {
  return {
    getSnapshot: vi.fn(() => ({ providerId: 'test', model: 'm', effort: 'none', messages: [] })),
    createSubAgent: vi.fn(() => ({ query })),
  } as unknown as CommandAgent;
}

function makeServices(): CommandRuntimeServices {
  return {
    showNotice: vi.fn(),
  } as unknown as CommandRuntimeServices;
}
