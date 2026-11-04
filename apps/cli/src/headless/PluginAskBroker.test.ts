import { describe, expect, it } from 'bun:test';
import type { MicaAskSnapshot } from '@packages/mica-runtime/index.js';
import { createPluginAskBroker } from './PluginAskBroker.js';

function createHarness() {
  const notifications: MicaAskSnapshot[] = [];
  const marks: (string | null)[] = [];
  const host = createPluginAskBroker({
    notify: (snapshot) => notifications.push(snapshot),
    markWaiting: (summary) => marks.push(summary),
    threadId: () => 'thread-1',
  });
  return { host, notifications, marks };
}

const question = {
  title: '先做哪个入口？',
  options: [
    { id: 'a', label: '方案 A' },
    { id: 'b', label: '方案 B' },
  ],
  summary: '等你选入口',
};

describe('createPluginAskBroker', () => {
  it('publishes the question, keeps it as pending, and clears both signals on answer', async () => {
    const { host, notifications, marks } = createHarness();
    const pending = host.forPlugin('ask').request(question);

    expect(host.pending()).toMatchObject({ pluginId: 'ask', summary: '等你选入口' });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].ask?.options.map((option) => option.id)).toEqual(['a', 'b']);
    // 选项上的 prompt / command 是插件自己的事，不该被推到界面上。
    expect(notifications[0].ask?.options[0]).not.toHaveProperty('prompt');
    expect(marks).toEqual(['等你选入口']);

    const askId = host.pending()!.id;
    expect(host.answer({ askId, optionIds: ['b'] })).toEqual({ ok: true });
    await expect(pending).resolves.toEqual({
      optionIds: ['b'],
      cancelled: false,
      reason: 'answered',
    });

    expect(host.pending()).toBeNull();
    expect(notifications.at(-1)?.ask).toBeNull();
    // 侧栏信号也要跟着撤掉，否则那一行会一直亮着。
    expect(marks).toEqual(['等你选入口', null]);
  });

  it('rejects an answer whose askId no longer matches', async () => {
    const { host } = createHarness();
    const pending = host.forPlugin('ask').request(question);
    expect(host.answer({ askId: 'ask_stale', optionIds: ['a'] })).toEqual({
      ok: false,
      error: '回答的不是当前这个问题',
    });
    host.answer({ askId: host.pending()!.id, optionIds: ['a'] });
    await pending;
  });

  it('times out into a cancelled answer instead of hanging the turn', async () => {
    const { host, marks } = createHarness();
    const answer = await host.forPlugin('ask').request({ ...question, timeoutMs: 1000 });
    expect(answer).toEqual({ optionIds: [], cancelled: true, reason: 'timeout' });
    expect(host.pending()).toBeNull();
    expect(marks).toEqual(['等你选入口', null]);
  }, 5000);

  it('aborts when the tool is cancelled, without waiting for the timeout', async () => {
    const { host, marks } = createHarness();
    const controller = new AbortController();
    const pending = host.forPlugin('ask').request(question, { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual({ optionIds: [], cancelled: true, reason: 'aborted' });
    expect(marks).toEqual(['等你选入口', null]);
  });

  it('asks one question at a time', async () => {
    const { host } = createHarness();
    const first = host.forPlugin('ask').request(question);
    expect(() => host.forPlugin('ask').request(question)).toThrow(/一次只能问一个/);
    host.answer({ askId: host.pending()!.id, optionIds: ['a'] });
    await first;
  });

  it('settles a pending question when the host goes away', async () => {
    const { host } = createHarness();
    const pending = host.forPlugin('ask').request(question);
    host.dispose();
    await expect(pending).resolves.toEqual({ optionIds: [], cancelled: true, reason: 'aborted' });
    expect(host.pending()).toBeNull();
  });
});
