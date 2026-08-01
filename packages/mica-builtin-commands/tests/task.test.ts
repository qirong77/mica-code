import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandRuntimeServices, RunningAgentRecord } from '../services.js';

const agents: RunningAgentRecord[] = [
  {
    id: 'agent-1',
    index: 1,
    title: 'Build UI',
    cwd: '/tmp/project',
    providerId: 'test',
    providerName: 'Test',
    model: 'model-a',
    status: { type: 'thinking' },
    current: false,
    startedAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:05:05.000Z',
  },
];

const backgroundTasks = [
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
  {
    id: 'finished1234',
    command: 'npm test',
    cwd: '/tmp/project',
    shell: '/bin/sh',
    pid: 2345,
    output_path: '/tmp/mica-tasks/finished1234.out',
    status: 'finished',
    started_at: '2026-01-02T03:04:05.000Z',
    finished_at: '2026-01-02T03:04:06.000Z',
    output_limit_bytes: 1024,
  },
];

const mocks = {
  logRuntime: vi.fn(),
  upsertPluginUI: vi.fn(),
  removePluginUI: vi.fn(),
  setAgentStatusItems: vi.fn(),
  setBackgroundTaskItems: vi.fn(),
  terminalClearText: vi.fn(),
  terminalTextGet: vi.fn(() => ''),
  agentStatusItemsGet: vi.fn(() => agents),
  backgroundTaskItemsGet: vi.fn(() => [
    {
      id: 'abc123def456',
      command: 'npm run dev',
      cwd: '/tmp/project',
      shell: '/bin/sh',
      pid: 1234,
      outputPath: '/tmp/mica-tasks/abc123def456.out',
      outputSize: 42,
      status: 'running',
      startedAt: '2026-01-02T03:04:05.000Z',
    },
    {
      id: 'finished1234',
      command: 'npm test',
      cwd: '/tmp/project',
      shell: '/bin/sh',
      pid: 2345,
      outputPath: '/tmp/mica-tasks/finished1234.out',
      outputSize: 42,
      status: 'finished',
      startedAt: '2026-01-02T03:04:05.000Z',
      finishedAt: '2026-01-02T03:04:06.000Z',
    },
  ]),
  listBackgroundTasks: vi.fn(() => backgroundTasks),
  getBackgroundTaskOutputSize: vi.fn(() => 42),
  readBackgroundTaskOutput: vi.fn(() => ({ content: 'ready\ntick', size: 10, start: 0, end: 10 })),
};

vi.mock('@packages/mica-tools/index.js', () => ({
  getBackgroundTaskOutputSize: mocks.getBackgroundTaskOutputSize,
  listBackgroundTasks: mocks.listBackgroundTasks,
  readBackgroundTaskOutput: mocks.readBackgroundTaskOutput,
}));

vi.mock('@packages/mica-ui/utils/format.js', () => ({
  formatElapsed: (ms: number) => `${ms}ms`,
  formatSessionListTime: (value: string) => value,
}));

vi.mock('@packages/mica-ui/utils/workingStatusDisplay.js', () => ({
  getWorkingStatusDisplay: (status: { type: string }) => ({
    text: status.type === 'connecting' ? 'waiting_model' : status.type,
    color: 'status',
    spinning: ['connecting', 'thinking', 'streaming', 'calling_tool'].includes(status.type),
  }),
}));

vi.mock('@packages/mica-ui/panels/BackgroundTaskRow.js', () => ({
  formatOutputSize: (bytes: number) => `${bytes}B`,
  formatTaskAge: () => '1000ms',
  formatTaskStatus: (status: string) => status,
  formatTaskTitle: (command: string) => command,
  isActiveBackgroundTaskStatus: (status: string) => status === 'starting' || status === 'running',
  statusColor: () => 'status',
}));

vi.mock('@packages/mica-ui/index.js', () => ({
  micaUi: {
    Dialog: ({ children }: { children: unknown }) => children,
    BottomScrollBox: ({ children }: { children: unknown }) => children,
    KeyHints: () => null,
    OneLineItem: () => null,
    SelectList: () => null,
    theme: { colors: { accent: 'accent', textSecondary: 'secondary', toolShell: 'shell' } },
    useScheduleState: (store: { get: () => unknown }) => store.get(),
    panels: {
      agentStatusItems: { get: mocks.agentStatusItemsGet },
      backgroundTaskItems: { get: mocks.backgroundTaskItemsGet },
      setAgentStatusItems: mocks.setAgentStatusItems,
      setBackgroundTaskItems: mocks.setBackgroundTaskItems,
      upsertPluginUI: mocks.upsertPluginUI,
      removePluginUI: mocks.removePluginUI,
    },
    terminalInput: {
      text: { get: mocks.terminalTextGet },
      clearText: mocks.terminalClearText,
    },
  },
}));

const { buildTaskListAgentCells, createTaskCommand } = await import('../commands/task.js');

describe('task command', () => {
  beforeEach(() => {
    mocks.upsertPluginUI.mockReset();
    mocks.removePluginUI.mockReset();
    mocks.setAgentStatusItems.mockReset();
    mocks.setBackgroundTaskItems.mockReset();
    mocks.terminalClearText.mockReset();
    mocks.terminalTextGet.mockClear();
    mocks.agentStatusItemsGet.mockClear();
    mocks.backgroundTaskItemsGet.mockClear();
    mocks.listBackgroundTasks.mockClear();
    mocks.getBackgroundTaskOutputSize.mockClear();
    mocks.readBackgroundTaskOutput.mockClear();
  });

  it('opens a panel for background and terminal tasks', () => {
    const services = makeServices();
    const command = createTaskCommand(services);

    command.action();

    expect(command.name).toBe('task');
    expect(command.completionItems).toEqual([{ arg: 'clear', description: '清除空闲任务' }]);
    expect(mocks.listBackgroundTasks).toHaveBeenCalledWith({ status: 'all' });
    expect(mocks.setBackgroundTaskItems).not.toHaveBeenCalled();
    expect(services.listRunningAgents).toHaveBeenCalledTimes(1);
    expect(mocks.setAgentStatusItems).toHaveBeenCalledWith(agents);
    expect(mocks.upsertPluginUI).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-panel' }));
  });

  it('renders agent rows with a status marker and task title only', () => {
    const cells = buildTaskListAgentCells(
      {
        ...agents[0],
        status: { type: 'connecting' },
        startedAt: '2026-01-02T03:04:05.000Z',
        updatedAt: '2026-01-02T03:05:05.000Z',
      },
      true,
    );

    expect(cells.map((cell) => cell.key)).toEqual(['marker', 'title']);
    expect(cells[0]).toEqual(expect.objectContaining({ flexShrink: 0 }));
    expect(cells[1]).toEqual(expect.objectContaining({ content: '#1 Build UI', flexGrow: 1, minWidth: 0 }));
  });

  it('clears idle terminal tasks', () => {
    const services = makeServices({ cleared: agents });
    const command = createTaskCommand(services);

    command.action('clear');

    expect(services.clearIdleAgents).toHaveBeenCalledTimes(1);
    expect(services.showNotice).toHaveBeenCalledWith('Cleared 1 idle task', undefined, {
      command: '/task',
      status: 'info',
    });
  });

  it('switches to the selected terminal task from the panel', () => {
    const services = makeServices();
    const command = createTaskCommand(services);
    command.action();

    const panel = mocks.upsertPluginUI.mock.calls[0]?.[0];
    panel.onInput('', { return: true });

    expect(services.switchAgentSession).toHaveBeenCalledWith('agent-1');
    expect(services.showNotice).toHaveBeenCalledWith('Switched to #1: Build UI', undefined, {
      command: '/task',
      status: 'success',
    });
  });

  it('opens detail for the selected background task from the panel', () => {
    const services = makeServices();
    const command = createTaskCommand(services);
    command.action();

    const panel = mocks.upsertPluginUI.mock.calls[0]?.[0];
    panel.onInput('', { downArrow: true });
    panel.onInput('', { return: true });

    expect(services.switchAgentSession).not.toHaveBeenCalled();
  });
});

function makeServices(options: { cleared?: RunningAgentRecord[] } = {}): CommandRuntimeServices {
  return {
    listRunningAgents: vi.fn(() => agents),
    listSubagentTasks: vi.fn(() => []),
    getSubagentTask: vi.fn(() => undefined),
    clearIdleAgents: vi.fn(() => ({ cleared: options.cleared ?? [], remaining: agents })),
    switchAgentSession: vi.fn((id: string) => {
      const agent = agents.find((candidate) => candidate.id === id);
      if (!agent) throw new Error(`unknown task: ${id}`);
      return agent;
    }),
    showMessage: vi.fn(),
    showNotice: vi.fn(),
  } as unknown as CommandRuntimeServices;
}
