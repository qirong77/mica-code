import { useEffect, useMemo, useState } from 'react';
import { basename } from 'node:path';
import { Box, Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaLogger } from '@packages/mica-logger/index.js';
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
import { getWorkingStatusDisplay } from '@packages/mica-ui/utils/workingStatusDisplay.js';
import { formatSessionListTime } from '@packages/mica-ui/utils/format.js';
import type { CommandRuntimeServices } from './services.js';
import { moveSelection } from './commandInput.js';

type TaskPanelState = { selectedIdx: number; detailTaskId: string | null };
type TaskListItem = { key: string; label: string; kind: 'background' | 'agent'; taskId: string };

const PANEL_ID = 'task-panel';
const DETAIL_OUTPUT_BYTES = 4000;

export function createTaskCommand(services: CommandRuntimeServices) {
  return {
    name: 'task',
    description: '显示后台任务和当前终端任务；/task clear 清除空闲任务',
    hiddenMenuItems: [{ arg: 'clear', description: '清除空闲任务' }],
    action: (arg?: string) => {
      if (arg?.trim().toLowerCase() === 'clear') {
        const result = services.clearIdleAgents();
        micaLogger.logRuntime('plugin.task', 'clear:done', { cleared: result.cleared.length });
        services.showMessage(
          result.cleared.length > 0
            ? `Cleared ${result.cleared.length} idle task${result.cleared.length === 1 ? '' : 's'}`
            : 'No idle tasks to clear',
          4000,
        );
        return;
      }

      const backgroundTasks = filterActiveBackgroundTasks(syncBackgroundTasks());
      const agents = services.listRunningAgents();
      micaUi.panels.setAgentStatusItems(agents);
      micaLogger.logRuntime('plugin.task', 'opened', {
        backgroundTasks: backgroundTasks.length,
        agents: agents.length,
      });
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
  const initialText = micaUi.terminalInput.text.get();
  const stateAtom = atom<TaskPanelState>({ selectedIdx: 0, detailTaskId: null });

  function hide() {
    if (micaUi.panels.removePluginUI(PANEL_ID)) micaLogger.logRuntime('plugin.task', 'closed');
  }

  function TaskPanel() {
    const state = micaUi.useScheduleState(stateAtom);
    const backgroundTasks = micaUi.useScheduleState(micaUi.panels.backgroundTaskItems);
    const agents = micaUi.useScheduleState(micaUi.panels.agentStatusItems);
    const [nowMs, setNowMs] = useState(() => Date.now());
    const activeBackgroundTasks = useMemo(() => filterActiveBackgroundTasks(backgroundTasks), [backgroundTasks]);
    const hasActiveBackgroundTasks = activeBackgroundTasks.length > 0;
    const items = useMemo(() => buildTaskListItems(activeBackgroundTasks, agents), [activeBackgroundTasks, agents]);
    const selectedIdx = clampIndex(state.selectedIdx, items.length);
    const detailTask = state.detailTaskId ? backgroundTasks.find((task) => task.id === state.detailTaskId) : undefined;

    useEffect(() => {
      const timer = setInterval(() => {
        syncBackgroundTasks();
        setNowMs(Date.now());
      }, hasActiveBackgroundTasks ? 1000 : 3000);
      return () => clearInterval(timer);
    }, [hasActiveBackgroundTasks]);

    if (detailTask) {
      return <BackgroundTaskDetail task={detailTask} nowMs={nowMs} />;
    }

    return (
      <micaUi.Dialog
        title={`tasks (${items.length})`}
        paddingX={0}
        footer={<micaUi.KeyHints hints={['↑↓ navigate', '↵ open/switch', 'esc close']} />}
      >
        <micaUi.SelectList
          items={items}
          selectedIdx={selectedIdx}
          itemGap={0}
          markerWidth={1}
          maxVisibleItems={12}
          empty={<Text dimColor>No tasks</Text>}
          renderItem={(item, isSelected) => {
            if (item.kind === 'background') {
              const task = activeBackgroundTasks.find((candidate) => candidate.id === item.taskId);
              if (!task) return null;
              return <TaskListBackgroundRow task={task} selected={isSelected} nowMs={nowMs} />;
            }

            const agent = agents.find((candidate) => candidate.id === item.taskId);
            if (!agent) return null;
            return <TaskListAgentRow agent={agent} selected={isSelected} />;
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
      const items = buildTaskListItems(filterActiveBackgroundTasks(backgroundTasks), agents);

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
      if (value !== initialText) hide();
      return false;
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
      <Box flexDirection="column" width="100%" minWidth={0}>
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
      </Box>
    </micaUi.Dialog>
  );
}

function TaskListBackgroundRow({
  task,
  selected,
  nowMs,
}: {
  task: MicaUiBackgroundTaskItem;
  selected: boolean;
  nowMs: number;
}) {
  return (
    <micaUi.OneLineItem
      cells={[
        { key: 'kind', content: '$', width: 2, color: micaUi.theme.colors.toolShell },
        { key: 'status', content: formatTaskStatus(task.status), width: 12, color: statusColor(task.status) },
        {
          key: 'title',
          content: formatTaskTitle(task.command),
          flexGrow: 1,
          minWidth: 18,
          color: selected ? micaUi.theme.colors.accent : undefined,
          bold: selected,
        },
        { key: 'workspace', content: basename(task.cwd) || task.cwd, width: 18, dimColor: !selected },
        { key: 'time', content: formatTaskAge(task, nowMs), width: 10, dimColor: !selected },
        { key: 'meta', content: formatOutputSize(task.outputSize), width: 10, dimColor: !selected },
        {
          key: 'id',
          content: task.id,
          width: 12,
          color: selected ? micaUi.theme.colors.accent : undefined,
          dimColor: !selected,
        },
      ]}
    />
  );
}

function TaskListAgentRow({ agent, selected }: { agent: MicaUiAgentStatusItem; selected: boolean }) {
  const status = getWorkingStatusDisplay(agent.status);
  return (
    <micaUi.OneLineItem
      cells={[
        { key: 'kind', content: '#', width: 2, color: micaUi.theme.colors.accent },
        { key: 'status', content: status.text, width: 12, color: status.color },
        {
          key: 'title',
          content: `#${agent.index} ${agent.title}`,
          flexGrow: 1,
          minWidth: 18,
          color: selected || agent.current ? micaUi.theme.colors.accent : undefined,
          bold: selected,
        },
        { key: 'workspace', content: formatAgentWorkspace(agent), width: 18, dimColor: !selected && !agent.current },
        { key: 'time', content: formatSessionListTime(agent.updatedAt), width: 10, dimColor: !selected },
        { key: 'meta', content: agent.model, width: 20, dimColor: !selected },
      ]}
    />
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

function filterActiveBackgroundTasks(
  tasks: readonly MicaUiBackgroundTaskItem[],
): readonly MicaUiBackgroundTaskItem[] {
  return tasks.filter((task) => isActiveBackgroundTaskStatus(task.status));
}

function formatAgentWorkspace(agent: MicaUiAgentStatusItem): string {
  const workspace = basename(agent.cwd) || agent.cwd;
  return agent.current ? `${workspace} · current` : workspace;
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
