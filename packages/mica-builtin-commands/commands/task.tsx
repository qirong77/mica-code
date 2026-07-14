import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Box, Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import {
  getBackgroundTaskOutputSize,
  listBackgroundTasks,
  readBackgroundTaskOutput,
  type BackgroundTaskMeta,
} from '@packages/mica-tools/index.js';
import { micaUi, type MicaUiBackgroundTaskItem, type MicaUiAgentStatusItem } from '@packages/mica-ui/index.js';
import {
  formatOutputSize,
  formatTaskAge,
  formatTaskStatus,
  formatTaskTitle,
  isActiveBackgroundTaskStatus,
  statusColor,
} from '@packages/mica-ui/panels/BackgroundTaskRow.js';
import { formatElapsed, formatSessionListTime } from '@packages/mica-ui/utils/format.js';
import { getWorkingStatusDisplay } from '@packages/mica-ui/utils/workingStatusDisplay.js';
import type { CommandRuntimeServices } from '../services.js';
import { moveSelection } from '../shared/commandInput.js';

type TaskPanelState = { selectedIdx: number; detailTaskId: string | null; query: string };
type TaskListItem = { key: string; label: string; kind: 'background' | 'agent'; taskId: string };

const PANEL_ID = 'task-panel';
const DETAIL_OUTPUT_BYTES = 4000;
const TASK_STATUS_MIN_WIDTH = 12;
const TASK_STATUS_MAX_WIDTH = 18;
const TASK_TIME_WIDTH = 16;

export function createTaskCommand(services: CommandRuntimeServices) {
  return {
    name: 'task',
    description: '显示后台任务和当前终端任务；/task clear 清除空闲任务',
    completionItems: [{ arg: 'clear', description: '清除空闲任务' }],
    action: (arg?: string) => {
      if (arg?.trim().toLowerCase() === 'clear') {
        const result = services.clearIdleAgents();
        services.showMessage(
          result.cleared.length > 0
            ? `Cleared ${result.cleared.length} idle task${result.cleared.length === 1 ? '' : 's'}`
            : 'No idle tasks to clear',
          4000,
        );
        return;
      }

      syncBackgroundTasks();
      const agents = services.listRunningAgents();
      micaUi.panels.setAgentStatusItems(agents);
      showTaskPanel(services);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

export function syncBackgroundTasks(): MicaUiBackgroundTaskItem[] {
  const tasks = listBackgroundTasks({ status: 'all' }).map(toUiBackgroundTask);
  micaUi.panels.setBackgroundTaskItems(tasks);
  return tasks;
}

function showTaskPanel(services: CommandRuntimeServices) {
  const stateAtom = atom<TaskPanelState>({ selectedIdx: 0, detailTaskId: null, query: '' });

  function hide() {
    micaUi.panels.removePluginUI(PANEL_ID);
  }

  function TaskPanel() {
    const state = micaUi.useScheduleState(stateAtom);
    const backgroundTasks = micaUi.useScheduleState(micaUi.panels.backgroundTaskItems);
    const agents = micaUi.useScheduleState(micaUi.panels.agentStatusItems);
    const [nowMs, setNowMs] = useState(() => Date.now());
    const activeBackgroundTasks = useMemo(() => filterActiveBackgroundTasks(backgroundTasks), [backgroundTasks]);
    const hasActiveBackgroundTasks = activeBackgroundTasks.length > 0;
    const items = useMemo(
      () => filterTaskListItems(buildTaskListItems(activeBackgroundTasks, agents), state.query),
      [activeBackgroundTasks, agents, state.query],
    );
    const statusWidth = useMemo(
      () =>
        micaUi.getOneLineColumnWidth(
          [
            ...activeBackgroundTasks.map((task) => formatTaskStatus(task.status)),
            ...agents.map((agent) => formatAgentStatusLabel(agent)),
          ],
          { min: TASK_STATUS_MIN_WIDTH, max: TASK_STATUS_MAX_WIDTH, padding: 1 },
        ),
      [activeBackgroundTasks, agents],
    );
    const selectedIdx = clampIndex(state.selectedIdx, items.length);
    const detailTask = state.detailTaskId ? backgroundTasks.find((task) => task.id === state.detailTaskId) : undefined;

    useEffect(() => {
      const timer = setInterval(
        () => {
          syncBackgroundTasks();
          setNowMs(Date.now());
        },
        hasActiveBackgroundTasks ? 1000 : 3000,
      );
      return () => clearInterval(timer);
    }, [hasActiveBackgroundTasks]);

    if (detailTask) {
      return <BackgroundTaskDetail task={detailTask} nowMs={nowMs} />;
    }

    return (
      <micaUi.Dialog
        title={`tasks (${items.length})`}
        paddingX={0}
        footer={<micaUi.KeyHints hints={['type to search', '↑↓ navigate', '↵ open/switch', 'esc close']} />}
      >
        <micaUi.SelectList
          items={items}
          selectedIdx={selectedIdx}
          itemGap={0}
          markerWidth={1}
          layout="table"
          empty={<Text dimColor>{state.query ? 'No matching tasks' : 'No tasks'}</Text>}
          renderItem={(item, isSelected, index) => {
            if (item.kind === 'background') {
              const task = activeBackgroundTasks.find((candidate) => candidate.id === item.taskId);
              if (!task) return null;
              return (
                <TaskListBackgroundRow
                  task={task}
                  selected={isSelected}
                  index={index}
                  nowMs={nowMs}
                  statusWidth={statusWidth}
                />
              );
            }

            const agent = agents.find((candidate) => candidate.id === item.taskId);
            if (!agent) return null;
            return (
              <TaskListAgentRow
                agent={agent}
                selected={isSelected}
                index={index}
                statusWidth={statusWidth}
                nowMs={nowMs}
              />
            );
          }}
        />
      </micaUi.Dialog>
    );
  }

  micaUi.panels.upsertPluginUI({
    id: PANEL_ID,
    component: TaskPanel,
    preserveInput: true,
    onInput: (_input, key) => {
      const state = stateAtom.get();
      const backgroundTasks = micaUi.panels.backgroundTaskItems.get();
      const agents = micaUi.panels.agentStatusItems.get();
      const items = filterTaskListItems(
        buildTaskListItems(filterActiveBackgroundTasks(backgroundTasks), agents),
        state.query,
      );

      if (key.escape) {
        if (state.detailTaskId) {
          stateAtom.set({ ...state, detailTaskId: null });
        } else {
          hide();
        }
        return true;
      }

      if (state.detailTaskId) return true;
      if (items.length === 0) return true;

      if (key.upArrow) {
        stateAtom.set({ ...state, selectedIdx: moveSelection(state.selectedIdx, items.length, -1) });
        return true;
      }

      if (key.downArrow) {
        stateAtom.set({ ...state, selectedIdx: moveSelection(state.selectedIdx, items.length, 1) });
        return true;
      }

      if (key.return) {
        openSelectedTask(services, items[clampIndex(state.selectedIdx, items.length)], hide, stateAtom);
        return true;
      }

      return false;
    },
    onTextChange: (value) => {
      stateAtom.set({ ...stateAtom.get(), selectedIdx: 0, query: value });
      return true;
    },
  });
}

function BackgroundTaskDetail({ task, nowMs }: { task: MicaUiBackgroundTaskItem; nowMs: number }) {
  const meta = loadTaskMeta(task.id);
  const output = meta
    ? readBackgroundTaskOutput(meta, { maxBytes: DETAIL_OUTPUT_BYTES, tailBytes: DETAIL_OUTPUT_BYTES })
    : undefined;
  const lines = (output?.content || '(no output)').split('\n').slice(-12);

  return (
    <micaUi.Dialog title={`task ${task.id}`} footer={<micaUi.KeyHints hints={['esc back']} />}>
      <micaUi.BottomScrollBox>
        <DetailLine label="status" value={formatTaskStatus(task.status)} color={statusColor(task.status)} />
        <DetailLine label="age" value={formatTaskAge(task, nowMs)} />
        <DetailLine label="pid" value={task.pid ? String(task.pid) : '-'} />
        <DetailLine label="output" value={`${formatOutputSize(task.outputSize)}  ${task.outputPath}`} />
        <DetailLine label="cwd" value={task.cwd} />
        <DetailLine label="command" value={task.command} />
        <Box paddingTop={1} paddingBottom={1}>
          <Text dimColor>output tail</Text>
        </Box>
        {lines.map((line, index) => (
          <Text key={`${index}-${line}`} dimColor wrap="truncate-end">
            {line || ' '}
          </Text>
        ))}
      </micaUi.BottomScrollBox>
    </micaUi.Dialog>
  );
}

function TaskListBackgroundRow({
  task,
  selected,
  index,
  nowMs,
  statusWidth,
}: {
  task: MicaUiBackgroundTaskItem;
  selected: boolean;
  index: number;
  nowMs: number;
  statusWidth: number;
}) {
  return (
    <TaskListRowSurface selected={selected} index={index}>
      <micaUi.OneLineItem
        cells={[
          {
            key: 'status',
            content: formatTaskStatus(task.status),
            width: statusWidth,
            flexShrink: 0,
            color: statusColor(task.status),
          },
          {
            key: 'time',
            content: formatTaskAge(task, nowMs),
            width: TASK_TIME_WIDTH,
            flexShrink: 0,
            color: selected ? micaUi.theme.colors.accent : undefined,
            dimColor: !selected,
          },
          {
            key: 'title',
            content: formatTaskTitle(task.command),
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 20,
            color: selected ? micaUi.theme.colors.accent : undefined,
            bold: selected,
          },
        ]}
      />
    </TaskListRowSurface>
  );
}

function TaskListAgentRow({
  agent,
  selected,
  index,
  statusWidth,
  nowMs,
}: {
  agent: MicaUiAgentStatusItem;
  selected: boolean;
  index: number;
  statusWidth: number;
  nowMs: number;
}) {
  return (
    <TaskListRowSurface selected={selected} index={index}>
      <micaUi.OneLineItem cells={buildTaskListAgentCells(agent, selected, { statusWidth, nowMs })} />
    </TaskListRowSurface>
  );
}

export function buildTaskListAgentCells(
  agent: MicaUiAgentStatusItem,
  selected: boolean,
  options: { statusWidth: number; nowMs?: number } = { statusWidth: TASK_STATUS_MIN_WIDTH },
) {
  const status = getWorkingStatusDisplay(agent.status);
  const highlight = selected || agent.current;
  return [
    {
      key: 'status',
      content: formatAgentStatusLabel(agent),
      width: options.statusWidth,
      flexShrink: 0,
      color: status.color,
    },
    {
      key: 'time',
      content: formatAgentListTime(agent, options.nowMs ?? Date.now()),
      width: TASK_TIME_WIDTH,
      flexShrink: 0,
      color: highlight ? micaUi.theme.colors.accent : undefined,
      dimColor: !highlight,
    },
    {
      key: 'title',
      content: formatAgentListTitle(agent),
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 20,
      color: highlight ? micaUi.theme.colors.accent : undefined,
      bold: selected,
    },
  ];
}

function formatAgentStatusLabel(agent: MicaUiAgentStatusItem): string {
  const status = getWorkingStatusDisplay(agent.status);
  return status.spinning ? `${status.text}...` : status.text;
}

function formatAgentListTitle(agent: MicaUiAgentStatusItem): string {
  return `#${agent.index} ${agent.title}`;
}

function formatAgentListTime(agent: MicaUiAgentStatusItem, nowMs: number): string {
  const status = getWorkingStatusDisplay(agent.status);
  if (status.spinning) {
    const startedMs = new Date(agent.startedAt).getTime();
    if (!Number.isNaN(startedMs)) {
      return formatElapsed(Math.max(0, nowMs - startedMs));
    }
  }
  return formatSessionListTime(agent.updatedAt, new Date(nowMs));
}

function TaskListRowSurface({ selected, index, children }: { selected: boolean; index: number; children: ReactNode }) {
  return (
    <Box width="100%" backgroundColor={selected ? '#3A3A3A' : index % 2 ? '#303030' : '#292929'}>
      {children}
    </Box>
  );
}

function DetailLine({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <micaUi.OneLineItem
      cells={[
        { key: 'label', content: label, width: 8, color: micaUi.theme.colors.textSecondary },
        { key: 'value', content: value, flexGrow: 1, minWidth: 0, color },
      ]}
    />
  );
}

function openSelectedTask(
  services: CommandRuntimeServices,
  item: TaskListItem | undefined,
  hide: () => void,
  stateAtom: ReturnType<typeof atom<TaskPanelState>>,
) {
  if (!item) return;
  if (item.kind === 'background') {
    stateAtom.set({ ...stateAtom.get(), detailTaskId: item.taskId });
    return;
  }

  try {
    const switched = services.switchAgentSession(item.taskId);
    services.showMessage(`Switched to #${switched.index}: ${switched.title}`, 4000);
    hide();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.showMessage(`Switch failed: ${message}`, 5000);
  }
}

function buildTaskListItems(
  backgroundTasks: readonly MicaUiBackgroundTaskItem[],
  agents: readonly MicaUiAgentStatusItem[],
): TaskListItem[] {
  return [
    ...backgroundTasks.map((task) => ({
      key: `background:${task.id}`,
      label: formatTaskTitle(task.command),
      kind: 'background' as const,
      taskId: task.id,
    })),
    ...agents.map((agent) => ({
      key: `agent:${agent.id}`,
      label: agent.title,
      kind: 'agent' as const,
      taskId: agent.id,
    })),
  ];
}

function filterActiveBackgroundTasks(tasks: readonly MicaUiBackgroundTaskItem[]): readonly MicaUiBackgroundTaskItem[] {
  return tasks.filter((task) => isActiveBackgroundTaskStatus(task.status));
}

function filterTaskListItems(items: TaskListItem[], query: string): TaskListItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return items;
  return items.filter((item) => item.label.toLowerCase().includes(normalizedQuery));
}

function toUiBackgroundTask(task: BackgroundTaskMeta): MicaUiBackgroundTaskItem {
  return {
    id: task.id,
    command: task.command,
    cwd: task.cwd,
    shell: task.shell,
    pid: task.pid,
    outputPath: task.output_path,
    outputSize: getBackgroundTaskOutputSize(task),
    status: task.status,
    startedAt: task.started_at,
    finishedAt: task.finished_at,
  };
}

function loadTaskMeta(id: string): BackgroundTaskMeta | undefined {
  return listBackgroundTasks({ status: 'all' }).find((task) => task.id === id);
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}
