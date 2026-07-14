import { describe, beforeEach, expect, it, vi } from 'vitest';
import type { CommandRuntimeServices, RewindApplyRequest, RewindPreviewResult } from './services.js';

const mocks = {
  setExclusivePluginUI: vi.fn(),
  removePluginUI: vi.fn(),
  terminalTextSet: vi.fn(),
};

vi.mock('@packages/mica-ui/index.js', () => ({
  micaUi: {
    Dialog: ({ children }: { children: unknown }) => children,
    KeyHints: () => null,
    SelectList: () => null,
    BottomScrollBox: ({ children }: { children: unknown }) => children,
    useScheduleState: (store: { get(): unknown }) => store.get(),
    dropdown: { setQuickCommands: vi.fn() },
    panels: {
      setExclusivePluginUI: mocks.setExclusivePluginUI,
      removePluginUI: mocks.removePluginUI,
    },
    terminalInput: {
      text: { set: mocks.terminalTextSet },
    },
    theme: {
      colors: {
        dim: 'gray',
        primary: 'blue',
        warning: 'yellow',
      },
    },
  },
}));

vi.mock('@packages/mica-ui/utils/format.js', () => ({
  formatSessionListTime: (value: string) => value,
}));

const { createRewindCommand } = await import('./rewind.js');

describe('rewind command', () => {
  beforeEach(() => {
    mocks.setExclusivePluginUI.mockReset();
    mocks.removePluginUI.mockReset();
    mocks.terminalTextSet.mockReset();
  });

  it('selects the latest checkpoint, rewinds files, and restores the original input', () => {
    const preview = makePreview({
      id: 'c2',
      conversationLabel: 'second display text',
      files: [{ path: 'src/a.ts', action: 'restore' }],
      previewToken: 'token-c2',
    });
    const services = makeServices({ preview });

    createRewindCommand(services).action();
    const panel = currentPanel();
    panel.onInput('', { return: true });
    panel.onInput('', { return: true });

    expect(services.getRewindPreview).toHaveBeenCalledWith('c2');
    expect(services.applyRewind).toHaveBeenCalledWith({
      id: 'c2',
      mode: 'conversation_and_files',
      previewToken: 'token-c2',
    });
    expect(mocks.terminalTextSet).toHaveBeenCalledWith('second raw input');
    expect(services.showNotice).toHaveBeenCalledWith(
      expect.stringContaining('原输入已恢复到输入框'),
      'session-1',
      { command: '/rewind', status: 'success' },
    );
  });

  it('defaults to conversation-only when the preview will delete a file', () => {
    const preview = makePreview({
      files: [{ path: 'generated.txt', action: 'delete' }],
    });
    const services = makeServices({ preview });

    createRewindCommand(services).action();
    const panel = currentPanel();
    panel.onInput('', { return: true });
    panel.onInput('', { return: true });

    expect(services.applyRewind).toHaveBeenCalledWith(expect.objectContaining({ mode: 'conversation_only' }));
  });

  it('can choose an older user turn from the checkpoint list', () => {
    const services = makeServices({ preview: makePreview({ id: 'c1', conversationLabel: 'first' }) });

    createRewindCommand(services).action();
    const panel = currentPanel();
    panel.onInput('', { downArrow: true });
    panel.onInput('', { return: true });

    expect(services.getRewindPreview).toHaveBeenCalledWith('c1');
  });

  it('refreshes a stale preview and requires a second confirmation', () => {
    const initial = makePreview({ previewToken: 'old-token' });
    const refreshed = makePreview({
      previewToken: 'new-token',
      files: [{ path: 'new.txt', action: 'delete' }],
    });
    const services = makeServices({ preview: initial });
    const getPreview = services.getRewindPreview as ReturnType<typeof vi.fn>;
    const applyRewind = services.applyRewind as ReturnType<typeof vi.fn>;
    getPreview.mockReturnValueOnce(initial).mockReturnValueOnce(refreshed);
    applyRewind
      .mockImplementationOnce(() => {
        throw new Error('rewind stale preview: workspace changed');
      })
      .mockReturnValueOnce(makeApplyResult({ mode: 'conversation_only' }));

    createRewindCommand(services).action();
    const panel = currentPanel();
    panel.onInput('', { return: true });
    panel.onInput('', { return: true });

    expect(services.applyRewind).toHaveBeenCalledTimes(1);
    expect(mocks.terminalTextSet).not.toHaveBeenCalled();
    expect(services.getRewindPreview).toHaveBeenCalledTimes(2);

    panel.onInput('', { return: true });
    expect(services.applyRewind).toHaveBeenLastCalledWith({
      id: 'c2',
      mode: 'conversation_only',
      previewToken: 'new-token',
    });
    expect(mocks.terminalTextSet).toHaveBeenCalledWith('second raw input');
  });
});

function makeServices(options: { preview: Extract<RewindPreviewResult, { ok: true }> }): CommandRuntimeServices {
  const checkpoints = [
    {
      id: 'c2',
      conversationLabel: 'second',
      createdAt: '2026-01-02T00:00:00.000Z',
      messageCountBefore: 2,
    },
    {
      id: 'c1',
      conversationLabel: 'first',
      createdAt: '2026-01-01T00:00:00.000Z',
      messageCountBefore: 0,
    },
  ];
  return {
    getCurrentAgentSessionId: vi.fn(() => 'session-1'),
    listRunningAgents: vi.fn(() => []),
    listRewindCheckpoints: vi.fn(() => checkpoints),
    getRewindPreview: vi.fn(() => options.preview),
    applyRewind: vi.fn((_request: RewindApplyRequest) => makeApplyResult()),
    showMessage: vi.fn(),
    showNotice: vi.fn(),
  } as unknown as CommandRuntimeServices;
}

function makePreview(
  overrides: Partial<Extract<RewindPreviewResult, { ok: true }>> = {},
): Extract<RewindPreviewResult, { ok: true }> {
  return {
    ok: true,
    id: 'c2',
    conversationLabel: 'second',
    createdAt: '2026-01-02T00:00:00.000Z',
    messageCountBefore: 2,
    messageCountNow: 4,
    fileStateAvailable: true,
    files: [],
    previewToken: 'token',
    ...overrides,
  };
}

function makeApplyResult(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c2',
    mode: 'conversation_and_files' as const,
    conversationLabel: 'second',
    inputText: 'second raw input',
    messageCountBefore: 2,
    messageCountNow: 4,
    messageCountRemoved: 2,
    conversationMessagesBefore: [],
    fileStateAvailable: true,
    files: [],
    ...overrides,
  };
}

function currentPanel(): {
  onInput(input: string, key: Record<string, boolean>): boolean;
} {
  const panel = mocks.setExclusivePluginUI.mock.calls.at(-1)?.[0];
  if (!panel) throw new Error('rewind panel was not opened');
  return panel;
}
