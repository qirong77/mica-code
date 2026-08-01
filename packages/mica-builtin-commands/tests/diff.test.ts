import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setExclusivePluginUI: vi.fn(),
  removePluginUI: vi.fn(),
  clearText: vi.fn(),
  showMessage: vi.fn(),
  showNotice: vi.fn(),
  loadFileDiff: vi.fn(),
  loadDiffSummary: vi.fn(() => ({ additions: 0, deletions: 0, files: new Map() })),
  useScheduleState: vi.fn((store: { get(): unknown }) => store.get()),
}));

vi.mock('@packages/mica-ui/index.js', () => ({
  micaUi: {
    dropdown: { setQuickCommands: vi.fn() },
    panels: {
      setExclusivePluginUI: mocks.setExclusivePluginUI,
      removePluginUI: mocks.removePluginUI,
    },
    terminalInput: { clearText: mocks.clearText },
    useScheduleState: mocks.useScheduleState,
    theme: { colors: {} },
    Dialog: () => null,
    KeyHints: () => null,
    SelectList: () => null,
    OneLineItem: () => null,
  },
}));

vi.mock('../git/gitDiff.js', () => ({
  loadFileDiff: mocks.loadFileDiff,
  loadDiffSummary: mocks.loadDiffSummary,
}));

import { createDiffCommand } from '../commands/diff.js';

describe('/diff command', () => {
  beforeEach(() => vi.clearAllMocks());

  it('打开文件列表，Enter 进入详情，Esc 返回列表后退出', () => {
    const file = { path: 'src/app.ts', status: ' M', owner: 'agent' as const };
    mocks.loadFileDiff.mockReturnValue({ file, rows: [], binary: false, additions: 0, deletions: 0 });
    const tracker = { list: vi.fn(() => [file]) };
    const agent = { taskOwnerId: 'agent-a' };
    const services = {
      getCurrentAgent: () => agent,
      showMessage: mocks.showMessage,
      showNotice: mocks.showNotice,
    };
    const command = createDiffCommand(agent as never, services as never, tracker as never);

    command.action();
    const panel = mocks.setExclusivePluginUI.mock.calls[0]?.[0];
    expect(panel).toBeDefined();
    expect(tracker.list).toHaveBeenCalledWith('agent-a');

    panel.component();
    expect(mocks.useScheduleState).toHaveBeenCalledTimes(3);

    panel.onInput('', { return: true });
    expect(mocks.loadFileDiff).toHaveBeenCalledWith(file);
    mocks.useScheduleState.mockClear();
    panel.component();
    expect(mocks.useScheduleState).toHaveBeenCalledTimes(3);
    panel.onInput('', { escape: true });
    expect(mocks.removePluginUI).not.toHaveBeenCalled();
    panel.onInput('', { escape: true });
    expect(mocks.removePluginUI).toHaveBeenCalledWith('git-diff-panel');
  });
});
