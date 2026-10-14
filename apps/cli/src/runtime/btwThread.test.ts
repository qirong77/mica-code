import { describe, expect, it, vi } from 'vitest';

import { BtwThreadController } from './btwThread.js';
import type { MicaBtwThread } from '@packages/mica-runtime/codexProtocol.js';
import type { CommandAgent, CommandSessionController } from '@packages/mica-builtin-commands/services.js';

type FakeOptions = {
  reply?: () => Promise<string>;
  messages?: unknown[];
};

function makeHarness(options: FakeOptions = {}) {
  const usageHistory: unknown[] = [];
  const query = vi.fn(async () => {
    usageHistory.push({ usageId: usageHistory.length + 1 });
    return options.reply ? await options.reply() : '旁路答案';
  });
  const recordSubagentUsage = vi.fn();
  const createSubAgent = vi.fn((_options?: { systemPrompt?: string }) => ({ query, usageHistory }));
  const saveCurrent = vi.fn();
  const agent = {
    config: { provider: { id: 'test' }, model: 'gpt-test', effort: 'medium' },
    isRunning: false,
    recordSubagentUsage,
    getSnapshot: () => ({
      providerId: 'test',
      model: 'gpt-test',
      effort: 'medium',
      role: 'default',
      messages: options.messages ?? [
        { role: 'user', content: '主流程问题' },
        { role: 'assistant', content: '主流程回答' },
      ],
      usageHistory: [],
    }),
    createSubAgent,
  } as unknown as CommandAgent;
  const sessionController = { saveCurrent } as unknown as CommandSessionController;
  const updates: MicaBtwThread[] = [];
  const controller = new BtwThreadController({
    agent,
    sessionController,
    onUpdate: (snapshot) => updates.push(snapshot),
  });
  return { agent, controller, updates, query, createSubAgent, recordSubagentUsage, saveCurrent, usageHistory };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('BtwThreadController', () => {
  it('answering one question pushes running then completed snapshots', async () => {
    const harness = makeHarness();
    expect(harness.controller.ask('这个方案可行吗')).toEqual({ ok: true });
    expect(harness.controller.snapshot().entries).toMatchObject([{ question: '这个方案可行吗', status: 'running' }]);
    await settle();
    expect(harness.controller.snapshot().entries).toMatchObject([
      { question: '这个方案可行吗', status: 'completed', answer: '旁路答案' },
    ]);
    expect(harness.updates).toHaveLength(2);
    expect(harness.updates[0].entries[0].status).toBe('running');
    expect(harness.updates[1].entries[0].status).toBe('completed');
    expect(harness.updates[0].id).toBe(harness.updates[1].id);
  });

  it('runs one question at a time', async () => {
    const harness = makeHarness();
    harness.controller.ask('第一个问题');
    const second = harness.controller.ask('第二个问题');
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.message).toContain('还在回答');
    await settle();
    expect(harness.controller.snapshot().entries).toHaveLength(1);
    expect(harness.query).toHaveBeenCalledTimes(1);
  });

  it('rejects empty questions', () => {
    const harness = makeHarness();
    expect(harness.controller.ask('   ').ok).toBe(false);
    expect(harness.controller.snapshot().entries).toHaveLength(0);
  });

  it('reuses one subagent across follow-ups and re-reads the transcript on a new topic', async () => {
    const harness = makeHarness();
    const first = harness.controller.ask('这个方案可行吗');
    await settle();
    expect(first.ok).toBe(true);
    harness.controller.ask('那成本呢');
    await settle();
    const thread = harness.controller.snapshot();
    expect(thread.entries).toHaveLength(2);
    expect(harness.query).toHaveBeenCalledTimes(2);
    // 同一话题复用同一个子代理，背景只取一次
    expect(harness.createSubAgent).toHaveBeenCalledTimes(1);

    harness.controller.ask('换个话题', { newThread: true });
    await settle();
    const fresh = harness.controller.snapshot();
    expect(fresh.id).not.toBe(thread.id);
    expect(fresh.entries).toMatchObject([{ question: '换个话题', status: 'completed' }]);
    expect(harness.createSubAgent).toHaveBeenCalledTimes(2);
    const systemPrompt = harness.createSubAgent.mock.calls[1]?.[0]?.systemPrompt ?? '';
    expect(systemPrompt).toContain('主流程问题');
  });

  it('reset clears the thread and notifies listeners', () => {
    const harness = makeHarness();
    harness.controller.ask('问题');
    harness.controller.reset();
    expect(harness.controller.snapshot().entries).toHaveLength(0);
    expect(harness.updates.at(-1)?.entries).toHaveLength(0);
  });

  it('records usage per request and marks failures', async () => {
    const harness = makeHarness({ reply: () => Promise.reject(new Error('模型挂了')) });
    harness.controller.ask('会失败的问题');
    await settle();
    expect(harness.recordSubagentUsage).toHaveBeenCalledTimes(1);
    expect(harness.recordSubagentUsage.mock.calls[0][0]).toMatchObject({
      subagentType: 'btw',
      status: 'failed',
      requests: [{ usageId: 1 }],
    });
    expect(harness.controller.snapshot().entries).toMatchObject([{ status: 'error', error: '模型挂了' }]);
    // 会话空闲时立刻落盘
    expect(harness.saveCurrent).toHaveBeenCalledWith({ allowEmpty: true });
  });

  it('does not save the session while a turn is running', async () => {
    const harness = makeHarness();
    (harness.agent as unknown as { isRunning: boolean }).isRunning = true;
    harness.controller.ask('问题');
    await settle();
    expect(harness.saveCurrent).not.toHaveBeenCalled();
  });

  it('keeps only the most recent entries', async () => {
    const harness = makeHarness();
    for (let index = 0; index < 40; index += 1) {
      harness.controller.ask(`问题 ${index}`);
      await settle();
    }
    const entries = harness.controller.snapshot().entries;
    expect(entries).toHaveLength(20);
    expect(entries.at(-1)?.question).toBe('问题 39');
  });
});
