import { useEffect, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import { micaLogger } from '@packages/mica-logger/index.js';
import {
  getBackgroundTaskOutputSize,
  listBackgroundTasks,
  type BackgroundTaskMeta,
  type BackgroundTaskStatus,
} from '@packages/mica-tools/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import { formatElapsed } from '@packages/mica-ui/utils/format.js';
import { formatSize } from '@packages/mica-tools/utils/outputLimits.js';

const PANEL_ID = 'task-panel';
const ACTIVE_STATUSES = new Set<BackgroundTaskStatus>(['starting', 'running']);

export function createTaskCommand() {
  return {
    name: 'task',
    description: '查看所有后台运行任务；/task all 查看全部后台任务',
    hiddenMenuItems: [{ arg: 'all', description: '查看全部后台任务' }],
    action: (arg?: string) => {
      const mode = arg?.trim().toLowerCase() === 'all' ? 'all' : 'running';
      const tasks = listTasks(mode);
      micaLogger.logRuntime('plugin.task', 'opened', { count: tasks.length, mode });
      showTaskPanel(mode);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

type TaskPanelMode = 'running' | 'all';

function showTaskPanel(mode: TaskPanelMode) {
  const initialText = micaUi.terminalInput.text.get();

  function hide() {
    if (micaUi.panels.removePluginUI(PANEL_ID)) micaLogger.logRuntime('plugin.task', 'closed');
  }

  function TaskPanel() {
    const [nowMs, setNowMs] = useState(() => Date.now());
    const tasks = listTasks(mode);
    const hasActiveTasks = tasks.some((task) => ACTIVE_STATUSES.has(task.status));

    useEffect(() => {
      if (!hasActiveTasks) return;
      const timer = setInterval(() => setNowMs(Date.now()), 1000);
      return () => clearInterval(timer);
    }, [hasActiveTasks]);

    return (
      <micaUi.Dialog
        title={`tasks (${mode === 'running' ? 'running, ' : ''}${tasks.length})`}
        footer={<micaUi.KeyHints hints={['esc close', 'type to close']} />}
      >
        <Box flexDirection="column" width="100%" minWidth={0}>
          {tasks.length === 0 ? (
            <Text dimColor>{mode === 'running' ? 'No running background tasks' : 'No background tasks'}</Text>
          ) : (
            <>
              <TaskHeader />
              {tasks.map((task) => (
                <TaskRow key={task.id} task={task} nowMs={nowMs} />
              ))}
              <Text color={micaUi.theme.colors.dim}>
                read_task_output(task_id="...") 查看输出，kill_task(task_id="...") 终止任务
              </Text>
            </>
          )}
        </Box>
      </micaUi.Dialog>
    );
  }

  micaUi.panels.upsertPluginUI({
    id: PANEL_ID,
    component: TaskPanel,
    preserveInput: true,
    onInput: (_input, key) => {
      if (!key.escape) return false;
      hide();
      return true;
    },
    onTextChange: (value) => {
      if (value !== initialText) hide();
      return false;
    },
  });
}

function listTasks(mode: TaskPanelMode): BackgroundTaskMeta[] {
  const tasks = listBackgroundTasks({ status: 'all' });
  if (mode === 'all') return tasks;
  return tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
}

function TaskHeader() {
  return (
    <>
      <micaUi.OneLineItem
        cells={[
          { key: 'id', content: 'id', width: 12, color: micaUi.theme.colors.textSecondary },
          { key: 'status', content: 'status', width: 14, color: micaUi.theme.colors.textSecondary },
          { key: 'pid', content: 'pid', width: 7, color: micaUi.theme.colors.textSecondary },
          { key: 'age', content: 'age', width: 9, color: micaUi.theme.colors.textSecondary },
          { key: 'output', content: 'output', width: 9, color: micaUi.theme.colors.textSecondary },
          { key: 'command', content: 'command', flexGrow: 1, minWidth: 12, color: micaUi.theme.colors.textSecondary },
        ]}
      />
      <Text color={micaUi.theme.colors.dim}>{'-'.repeat(78)}</Text>
    </>
  );
}

function TaskRow({ task, nowMs }: { task: BackgroundTaskMeta; nowMs: number }) {
  return (
    <micaUi.OneLineItem
      cells={[
        { key: 'id', content: task.id, width: 12, color: micaUi.theme.colors.accent },
        { key: 'status', content: task.status, width: 14, color: statusColor(task.status) },
        { key: 'pid', content: task.pid ? String(task.pid) : '-', width: 7, dimColor: !task.pid },
        { key: 'age', content: formatTaskAge(task, nowMs), width: 9, dimColor: true },
        { key: 'output', content: formatSize(getBackgroundTaskOutputSize(task)), width: 9, dimColor: true },
        { key: 'command', content: task.command, flexGrow: 1, minWidth: 12 },
      ]}
    />
  );
}

function formatTaskAge(task: BackgroundTaskMeta, nowMs: number): string {
  const started = Date.parse(task.started_at);
  if (Number.isNaN(started)) return 'unknown';
  const finished = task.finished_at ? Date.parse(task.finished_at) : nowMs;
  return formatElapsed(Math.max(0, (Number.isNaN(finished) ? nowMs : finished) - started));
}

function statusColor(status: BackgroundTaskStatus): string | undefined {
  if (status === 'running' || status === 'starting') return micaUi.theme.colors.info;
  if (status === 'finished') return micaUi.theme.colors.success;
  if (status === 'killed' || status === 'failed') return micaUi.theme.colors.error;
  return micaUi.theme.colors.warning;
}
