import { describe, expect, it, vi } from 'vitest';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import { TurnNoticeLog, type TurnNotice } from '../runtime/turnNotices.js';
import { createHeadlessRuntimeServices, type HeadlessRuntimeServicesOptions } from './headlessRuntimeServices.js';

function mount(onNotice?: HeadlessRuntimeServicesOptions['onNotice']) {
  const base: MicaUiConversationMessage[] = [];
  const log = new TurnNoticeLog(() => base);
  const saveCurrent = vi.fn();
  const services = createHeadlessRuntimeServices({
    agent: {} as HeadlessRuntimeServicesOptions['agent'],
    sessionController: { saveCurrent } as unknown as HeadlessRuntimeServicesOptions['sessionController'],
    subagentTasks: {} as HeadlessRuntimeServicesOptions['subagentTasks'],
    notices: { ensure: () => log },
    isBusy: () => false,
    submit: async () => ({ ok: true }),
    onNotice,
  });
  return { services, base, log, saveCurrent };
}

describe('headless notice updates', () => {
  it('saves and emits both the full notice and its display preview', () => {
    const onNotice = vi.fn();
    const { services, log, saveCurrent } = mount(onNotice);
    services.showNotice('完整摘要', undefined, { variant: 'digest', displayContent: '短摘要…', status: 'info' });
    const notice = expect.objectContaining({ content: '完整摘要', displayContent: '短摘要…' });
    expect(log.compose()).toEqual([notice]);
    expect(saveCurrent.mock.lastCall?.[0].conversationMessages).toEqual([notice]);
    expect(onNotice).toHaveBeenCalledWith(notice, expect.anything());
    const restored = mount().log;
    restored.restore(log.compose());
    expect(restored.compose()).toEqual([notice]);
  });
  it('pushes running and success after each save, preserving the running slot and replace intent', () => {
    const order: string[] = [];
    const onNotice = vi.fn((notice: TurnNotice, options: { replace?: boolean; noticeIndex: number }): void => {
      order.push(`push:${notice.status}`);
      expect(saveCurrent).toHaveBeenCalledTimes(onNotice.mock.calls.length);
      expect(saveCurrent.mock.lastCall?.[0].conversationMessages).toContainEqual(notice);
      expect(options).toEqual({ replace: true, noticeIndex: 0 });
    });
    const { services, base, log, saveCurrent } = mount(onNotice);
    saveCurrent.mockImplementation(({ conversationMessages }) => {
      const notice = conversationMessages.find((message: MicaUiConversationMessage) => message.role === 'notice');
      order.push(`save:${notice.status}`);
    });

    services.showNotice('Working', undefined, {
      variant: 'config',
      command: '/progress',
      status: 'running',
      replace: true,
    });
    // More provider text can arrive while the plugin is still working.
    base.push({ role: 'assistant', content: 'Still streaming' });
    services.showNotice('Done', undefined, {
      variant: 'config',
      command: '/progress',
      status: 'success',
      replace: true,
    });

    expect(order).toEqual(['save:running', 'push:running', 'save:success', 'push:success']);
    expect(onNotice.mock.calls.map(([notice]) => notice)).toEqual([
      { role: 'notice', content: 'Working', variant: 'config', command: '/progress', status: 'running' },
      { role: 'notice', content: 'Done', variant: 'config', command: '/progress', status: 'success' },
    ]);
    expect(log.compose()).toEqual([onNotice.mock.calls[1]![0], base[0]]);
  });

  it('assigns new notice slots to repeated command events across turns without persisting the index', () => {
    const onNotice = vi.fn();
    const { services, base, log, saveCurrent } = mount(onNotice);
    log.restore([{ role: 'notice', content: 'Earlier notice' }]);
    base.push({ role: 'user', content: 'First turn' });
    services.showNotice('First result', undefined, { command: '/event', status: 'success' });
    base.push({ role: 'assistant', content: 'First answer' }, { role: 'user', content: 'Second turn' });
    services.showNotice('Second result', undefined, { command: '/event', status: 'success' });

    expect(onNotice.mock.calls.map(([, options]) => options)).toEqual([
      { replace: undefined, noticeIndex: 1 },
      { replace: undefined, noticeIndex: 2 },
    ]);
    const notices = log.compose().filter((message) => message.role === 'notice');
    expect(notices.map((notice) => notice.content)).toEqual(['Earlier notice', 'First result', 'Second result']);
    expect(saveCurrent.mock.lastCall?.[0].conversationMessages).toEqual(log.compose());
    for (const notice of notices) expect(notice).not.toHaveProperty('noticeIndex');
  });

  it('does not push when saving throws', () => {
    const onNotice = vi.fn();
    const { services, saveCurrent } = mount(onNotice);
    saveCurrent.mockImplementation(() => {
      throw new Error('save failed');
    });

    expect(() => services.showNotice('Working', undefined, { status: 'running' })).toThrow('save failed');
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('keeps the callback optional for exec and pushes commit notices through the same path', () => {
    const withoutCallback = mount();
    expect(() => withoutCallback.services.showNotice('Saved')).not.toThrow();
    expect(withoutCallback.saveCurrent).toHaveBeenCalledOnce();

    const onNotice = vi.fn();
    const { services, saveCurrent } = mount(onNotice);
    services.showCommitNotice('Committed');
    expect(saveCurrent).toHaveBeenCalledOnce();
    expect(onNotice).toHaveBeenCalledWith(
      { role: 'notice', content: 'Committed', variant: 'commit', command: '/commit', status: 'success' },
      { noticeIndex: 0 },
    );
  });
});
