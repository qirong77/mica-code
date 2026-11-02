import { describe, expect, it, vi } from 'vitest';
import { micaUi } from '@packages/mica-ui/index.js';
import { arrangeResumeSessions, createResumeCommand } from '@packages/mica-builtin-commands/commands/resume.js';

function session(id: string, parentSessionId?: string) {
  return { id, parentSessionId, title: id, updatedAt: '2026-01-01', cwd: process.cwd(), model: 'model', uncompleted: false };
}

describe('resume session hierarchy', () => {
  it('keeps sorted roots and siblings while placing descendants after their parent', () => {
    const rows = arrangeResumeSessions([
      session('child-new', 'parent'), session('other'), session('grandchild', 'child-new'),
      session('parent'), session('child-old', 'parent'), session('legacy'),
    ]);
    expect(rows.map(({ session, depth }) => [session.id, depth])).toEqual([
      ['other', 0], ['parent', 0], ['child-new', 1], ['grandchild', 2], ['child-old', 1], ['legacy', 0],
    ]);
  });

  it('keeps orphans, self references, and cycles selectable', () => {
    const rows = arrangeResumeSessions([
      session('orphan', 'missing'), session('self', 'self'), session('a', 'b'),
      session('b', 'a'), session('child', 'a'),
    ]);
    expect(rows.map(({ session, depth }) => [session.id, depth])).toEqual([
      ['orphan', 0], ['self', 0], ['a', 0], ['child', 1], ['b', 0],
    ]);
  });

  it('selects the visible child after navigation and when search hides its parent', async () => {
    let panel: any;
    const show = vi.spyOn(micaUi.panels, 'setExclusivePluginUI').mockImplementation((value) => { panel = value; });
    const schedule = vi.spyOn(micaUi, 'useScheduleState').mockImplementation((state: any) => state.get());
    const clear = vi.spyOn(micaUi.panels, 'clearPluginUIs').mockImplementation(() => {});
    const clearText = vi.spyOn(micaUi.terminalInput, 'clearText').mockImplementation(() => {});
    const resume = vi.fn(() => ({ ok: false as const, message: 'test' }));
    const controller = { list: vi.fn(() => [session('child', 'parent'), session('parent')]), resume };
    const services = { isAgentBusy: () => false, showNotice: vi.fn() };
    try {
      await createResumeCommand({} as never, controller as never, services as never).action();
      expect(controller.list).toHaveBeenCalledWith(1000);
      expect(panel.component().props.children.props.items.map((item: any) => [item.key, item.label])).toEqual([
        ['parent', 'parent'], ['child', '  ↳ child'],
      ]);
      panel.onInput('', { downArrow: true });
      panel.onInput('', { return: true });
      expect(resume).toHaveBeenLastCalledWith('child');
      await createResumeCommand({} as never, controller as never, services as never).action();
      panel.onTextChange('child');
      panel.onInput('', { return: true });
      expect(resume).toHaveBeenLastCalledWith('child');
    } finally {
      show.mockRestore(); schedule.mockRestore(); clear.mockRestore(); clearText.mockRestore();
    }
  });
});
