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

  it('posts without holding the caller, and settles later when answered', async () => {
    const { host, notifications, marks } = createHarness();
    // 关键点：post() 是同步返回的——调用方（比如定时检查）不会因为没人点而卡住。
    const handle = host.forPlugin('session-compact').post(question);
    expect(handle.id).toBe(host.pending()!.id);
    expect(host.pending()!.passive).toBe(true);
    // 侧栏那行用 summary（短的），没有才退回 title
    expect(marks.at(-1)).toBe('等你选入口');
    expect(notifications.at(-1)?.ask?.passive).toBe(true);

    host.answer({ askId: handle.id, optionIds: ['a'] });
    await expect(handle.answered).resolves.toMatchObject({ optionIds: ['a'], cancelled: false });
    expect(host.pending()).toBeNull();
  });

  it('drops a posted question when the plugin changes its mind', async () => {
    const { host } = createHarness();
    const handle = host.forPlugin('session-compact').post(question);
    handle.dismiss();
    await expect(handle.answered).resolves.toMatchObject({ cancelled: true, reason: 'cancelled' });
    expect(host.pending()).toBeNull();
  });

  it('lets a blocking question take the slot from a posted one', () => {
    const { host } = createHarness();
    const posted = host.forPlugin('session-compact').post(question);
    // 被动那条没人等，被顶掉不损失任何东西；真在等的那条优先。
    const blocking = host.forPlugin('ask').request({ ...question, title: '工具要问的' });
    expect(host.pending()?.title).toBe('工具要问的');
    expect(host.pending()?.passive).toBeFalsy();
    void posted.answered.then((answer) => {
      expect(answer).toMatchObject({ cancelled: true, reason: 'cancelled' });
    });
    host.dispose();
    void blocking;
  });

  it('treats a dismiss from the page as cancelled, not as an empty choice', async () => {
    const { host } = createHarness();
    const pending = host.forPlugin('ask').request(question);
    expect(host.answer({ askId: host.pending()!.id, cancelled: true })).toEqual({ ok: true });
    await expect(pending).resolves.toEqual({
      optionIds: [],
      cancelled: true,
      reason: 'cancelled',
    });
  });
});
