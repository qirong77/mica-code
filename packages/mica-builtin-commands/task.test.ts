import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = {
  logRuntime: vi.fn(),
  upsertPluginUI: vi.fn(),
  removePluginUI: vi.fn(),
  terminalTextGet: vi.fn(() => ''),
  listBackgroundTasks: vi.fn(() => [
    {
      id: 'abc123def456',
      command: 'npm run dev',
      cwd: '/tmp/project',
      shell: '/bin/sh',
      pid: 1234,
      output_path: '/tmp/mica-tasks/abc123def456.out',
      status: 'running',
      started_at: '2026-01-02T03:04:05.000Z',
      output_limit_bytes: 1024,
    },
  ]),
  getBackgroundTaskOutputSize: vi.fn(() => 42),
};

vi.mock('@packages/mica-logger/index.js', () => ({
  micaLogger: {
    logRuntime: mocks.logRuntime,
  },
}));

vi.mock('@packages/mica-tools/index.js', () => ({
  getBackgroundTaskOutputSize: mocks.getBackgroundTaskOutputSize,
  listBackgroundTasks: mocks.listBackgroundTasks,
}));

vi.mock('@packages/mica-tools/utils/outputLimits.js', () => ({
  formatSize: (bytes: number) => `${bytes}B`,
}));

vi.mock('@packages/mica-ui/utils/format.js', () => ({
  formatElapsed: (ms: number) => `${ms}ms`,
}));

vi.mock('@packages/mica-ui/index.js', () => ({
  micaUi: {
    Dialog: ({ children }: { children: unknown }) => children,
    KeyHints: () => null,
    OneLineItem: () => null,
    theme: {
      colors: {
        accent: 'accent',
        dim: 'dim',
        error: 'error',
        info: 'info',
        success: 'success',
        textSecondary: 'secondary',
        warning: 'warning',
      },
    },
    panels: {
      upsertPluginUI: mocks.upsertPluginUI,
      removePluginUI: mocks.removePluginUI,
    },
    terminalInput: {
      text: { get: mocks.terminalTextGet },
    },
  },
}));

const { createTaskCommand } = await import('./task.js');

describe('task command', () => {
  beforeEach(() => {
    mocks.logRuntime.mockReset();
    mocks.upsertPluginUI.mockReset();
    mocks.removePluginUI.mockReset();
    mocks.terminalTextGet.mockClear();
    mocks.listBackgroundTasks.mockClear();
    mocks.getBackgroundTaskOutputSize.mockClear();
  });

  it('opens a panel for background tasks', () => {
    const command = createTaskCommand();
    command.action();

    expect(command.name).toBe('task');
    expect(mocks.listBackgroundTasks).toHaveBeenCalledWith({ status: 'all' });
    expect(mocks.logRuntime).toHaveBeenCalledWith('plugin.task', 'opened', { count: 1, mode: 'running' });
    expect(mocks.upsertPluginUI).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-panel' }));
  });

  it('supports showing all background tasks', () => {
    const command = createTaskCommand();
    command.action('all');

    expect(command.hiddenMenuItems).toEqual([{ arg: 'all', description: '查看全部后台任务' }]);
    expect(mocks.logRuntime).toHaveBeenCalledWith('plugin.task', 'opened', { count: 1, mode: 'all' });
  });
});
