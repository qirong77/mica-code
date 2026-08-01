import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Box, Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import { formatTokenCount } from '@packages/mica-common/format.js';
import {
  cleanBackgroundTaskOutput,
  getBackgroundTaskOutputSize,
  killBackgroundTask,
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
import { formatElapsed } from '@packages/mica-ui/utils/format.js';
import { getWorkingStatusDisplay } from '@packages/mica-ui/utils/workingStatusDisplay.js';
import type {
  CommandRuntimeServices,
  SubagentTaskDetail,
  SubagentTaskStatus,
  SubagentTaskSummary,
} from '../services.js';
import { handleScrollInput, moveSelection } from '../shared/commandInput.js';
import {
  createCommandScrollController,
  ScrollableCommandDialog,
  type CommandScrollController,
} from '../shared/ScrollableCommandDialog.js';

type TaskDetailTarget = { kind: 'background' | 'subagent'; taskId: string };
type TaskPanelState = { selectedIdx: number; detail: TaskDetailTarget | null; query: string };
type TaskListItem = {
  key: string;
  label: string;
  kind: 'background' | 'session' | 'subagent';
  taskId: string;
  searchText: string;
  groupId: string;
  treePrefix: string;
};

const PANEL_ID = 'task-panel';
const DETAIL_OUTPUT_BYTES = 4000;
const PROMPT_PREVIEW_CHARS = 12_000;
const RESULT_PREVIEW_CHARS = 40_000;

export function createTaskCommand(services: CommandRuntimeServices) {
  return {
    name: 'task',
    description: '显示终端 session、subagent 和后台 shell；/task clear 清除空闲任务',
    completionItems: [{ arg: 'clear', description: '清除空闲任务' }],
    action: (arg?: string) => {
      if (arg?.trim().toLowerCase() === 'clear') {
        const result = services.clearIdleAgents();
        services.showNotice(
          result.cleared.length > 0
            ? `Cleared ${result.cleared.length} idle task${result.cleared.length === 1 ? '' : 's'}`
            : 'No idle tasks to clear',
          undefined,
          { command: '/task', status: 'info' },
        );
        return;
      }

      showTaskPanel(services);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

export function syncBackgroundTasks(): MicaUiBackgroundTaskItem[] {
  const tasks = loadBackgroundTasks();
  micaUi.panels.setBackgroundTaskItems(tasks);
  return tasks;
}

function showTaskPanel(services: CommandRuntimeServices) {
  micaUi.panels.setAgentStatusItems(services.listRunningAgents());

  const stateAtom = atom<TaskPanelState>({ selectedIdx: 0, detail: null, query: '' });
  const backgroundTasksAtom = atom<MicaUiBackgroundTaskItem[]>(loadBackgroundTasks());
  const subagentTasksAtom = atom<SubagentTaskSummary[]>(services.listSubagentTasks?.() ?? []);
  const detailScroll = createCommandScrollController();

  function hide() {
    micaUi.terminalInput.clearText();
    micaUi.panels.removePluginUI(PANEL_ID);
  }

  function TaskPanel() {
    const state = micaUi.useScheduleState(stateAtom);
    const backgroundTasks = micaUi.useScheduleState(backgroundTasksAtom);
    const agents = micaUi.useScheduleState(micaUi.panels.agentStatusItems);
    const subagentTasks = micaUi.useScheduleState(subagentTasksAtom);
    const [nowMs, setNowMs] = useState(() => Date.now());
    const activeBackgroundTasks = useMemo(() => filterActiveBackgroundTasks(backgroundTasks), [backgroundTasks]);
    const hasRunningTasks = useMemo(
      () =>
        activeBackgroundTasks.length > 0 ||
        subagentTasks.some((task) => task.status === 'running') ||
        agents.some(isActiveAgentSession),
      [activeBackgroundTasks, agents, subagentTasks],
    );
    const items = useMemo(
      () => filterTaskListItems(buildTaskListItems(activeBackgroundTasks, agents, subagentTasks), state.query),
      [activeBackgroundTasks, agents, state.query, subagentTasks],
    );
    const backgroundTaskById = useMemo(
      () => new Map(activeBackgroundTasks.map((task) => [task.id, task])),
      [activeBackgroundTasks],
    );
    const subagentTaskById = useMemo(() => new Map(subagentTasks.map((task) => [task.id, task])), [subagentTasks]);
    const selectedIdx = clampIndex(state.selectedIdx, items.length);

    useEffect(() => {
      const timer = setInterval(
        () => {
          backgroundTasksAtom.set(loadBackgroundTasks());
          micaUi.panels.setAgentStatusItems(services.listRunningAgents());
          subagentTasksAtom.set(services.listSubagentTasks?.() ?? []);
          setNowMs(Date.now());
        },
        hasRunningTasks ? 1000 : 3000,
      );
      return () => clearInterval(timer);
    }, [hasRunningTasks]);

    if (state.detail?.kind === 'background') {
      const detailTask = backgroundTasks.find((task) => task.id === state.detail?.taskId);
      return detailTask ? (
        <BackgroundTaskDetail task={detailTask} nowMs={nowMs} scroll={detailScroll} />
      ) : (
        <MissingTaskDetail taskId={state.detail.taskId} />
      );
    }

    if (state.detail?.kind === 'subagent') {
      return (
        <SubagentTaskDetailView services={services} taskId={state.detail.taskId} nowMs={nowMs} scroll={detailScroll} />
      );
    }

    return (
      <micaUi.Dialog
        title={`tasks (${items.length})`}
        paddingX={0}
        footer={
          <micaUi.KeyHints
            hints={['type to search', '↑↓ navigate', '↵ switch session / open task', 'x stop shell', 'esc close']}
          />
        }
      >
        <micaUi.SelectList
          items={items}
          selectedIdx={selectedIdx}
          itemGap={0}
          marker=""
          markerWidth={0}
          layout="table"
          empty={<Text dimColor>{state.query ? 'No matching tasks' : 'No tasks'}</Text>}
          renderItem={(item, isSelected) => {
            if (item.kind === 'background') {
              const task = backgroundTaskById.get(item.taskId);
              if (!task) return null;
              return <TaskListBackgroundRow task={task} selected={isSelected} treePrefix={item.treePrefix} />;
            }

            if (item.kind === 'session') {
              const agent = agents.find((candidate) => candidate.id === item.taskId);
              if (!agent) return null;
              return <TaskListAgentRow agent={agent} selected={isSelected} treePrefix={item.treePrefix} />;
            }

            const task = subagentTaskById.get(item.taskId);
            if (!task) return null;
            return <TaskListSubagentRow task={task} selected={isSelected} treePrefix={item.treePrefix} />;
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
      const backgroundTasks = backgroundTasksAtom.get();
      const agents = micaUi.panels.agentStatusItems.get();
      const subagentTasks = subagentTasksAtom.get();
      const items = filterTaskListItems(
        buildTaskListItems(filterActiveBackgroundTasks(backgroundTasks), agents, subagentTasks),
        state.query,
      );

      if (key.escape) {
        if (state.detail) {
          stateAtom.set({ ...state, detail: null });
        } else {
          hide();
        }
        return true;
      }

      if (state.detail) {
        return handleScrollInput(detailScroll, key);
      }
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

      if (_input.toLowerCase() === 'x') {
        const selected = items[clampIndex(state.selectedIdx, items.length)];
        if (selected?.kind === 'background') {
          void stopSelectedBackgroundTask(services, selected.taskId, backgroundTasksAtom, stateAtom);
          return true;
        }
      }

      return false;
    },
    onTextChange: (value) => {
      const state = stateAtom.get();
      if (!state.detail) stateAtom.set({ ...state, selectedIdx: 0, query: value });
      return true;
    },
  });
}

async function stopSelectedBackgroundTask(
  services: CommandRuntimeServices,
  taskId: string,
  backgroundTasksAtom: ReturnType<typeof atom<MicaUiBackgroundTaskItem[]>>,
  stateAtom: ReturnType<typeof atom<TaskPanelState>>,
): Promise<void> {
  const before = loadTaskMeta(taskId);
  if (!before) return;
  const result = await killBackgroundTask(taskId, 'SIGTERM', 1500);
  const task = result.meta ?? loadTaskMeta(taskId) ?? before;
  const output = cleanBackgroundTaskOutput(
    readBackgroundTaskOutput(task, {
      maxBytes: DETAIL_OUTPUT_BYTES,
      tailBytes: DETAIL_OUTPUT_BYTES,
    }).content,
  );
  services.showNotice(`$ ${task.command}\n\n${output || result.message}`, services.getCurrentAgentSessionId(), {
    command: `! ${task.command} · ${task.id}`,
    status: result.ok ? 'warning' : 'error',
  });
  backgroundTasksAtom.set(loadBackgroundTasks());
  stateAtom.set({ ...stateAtom.get(), selectedIdx: 0 });
}

function BackgroundTaskDetail({
  task,
  nowMs,
  scroll,
}: {
  task: MicaUiBackgroundTaskItem;
  nowMs: number;
  scroll: CommandScrollController;
}) {
  const meta = loadTaskMeta(task.id);
  const output = meta
    ? readBackgroundTaskOutput(meta, { maxBytes: DETAIL_OUTPUT_BYTES, tailBytes: DETAIL_OUTPUT_BYTES })
    : undefined;
  const lines = (output?.content || '(no output)').split('\n').slice(-12);

  return (
    <ScrollableCommandDialog title={`task ${task.id}`} controller={scroll} hints={['esc back']}>
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
    </ScrollableCommandDialog>
  );
}

function SubagentTaskDetailView({
  services,
  taskId,
  nowMs,
  scroll,
}: {
  services: CommandRuntimeServices;
  taskId: string;
  nowMs: number;
  scroll: CommandScrollController;
}) {
  const task = services.getSubagentTask(taskId);
  if (!task) return <MissingTaskDetail taskId={taskId} />;

  const prompt = task.prompt?.trim() ? task.prompt : task.description;
  const promptPreview = truncatePreview(prompt, PROMPT_PREVIEW_CHARS);
  const resultPreview = truncatePreview(formatSubagentResult(task), RESULT_PREVIEW_CHARS);

  return (
    <ScrollableCommandDialog title={`subagent ${task.id}`} controller={scroll} hints={['esc back']}>
      <WrappedDetailLine label="status" value={task.status} color={subagentStatusAppearance(task.status).color} />
      <WrappedDetailLine label="owner" value={formatSubagentOwner(task)} />
      <WrappedDetailLine label="task id" value={task.id} />
      <WrappedDetailLine label="elapsed" value={formatSubagentTaskAge(task, nowMs)} />
      <WrappedDetailLine label="model" value={task.model || '-'} />
      <WrappedDetailLine label="effort" value={task.effort || '-'} />
      <WrappedDetailLine label="max turns" value={task.maxTurns === undefined ? '-' : String(task.maxTurns)} />
      <WrappedDetailLine label="context" value={task.contextMode ?? '-'} />
      <WrappedDetailLine label="write mode" value={task.writeMode ?? '-'} />
      <WrappedDetailLine label="context files" value={formatStringList(task.contextFiles)} />
      <WrappedDetailLine label="owned paths" value={formatStringList(task.ownedPaths)} />
      <WrappedDetailLine label="usage" value={formatSubagentUsage(task)} />
      <DetailTextSection label="task" value={promptPreview} />
      {task.error ? (
        <DetailTextSection label="error" value={task.error} color={micaUi.theme.colors.statusError} />
      ) : null}
      <DetailTextSection label="result" value={resultPreview} />
    </ScrollableCommandDialog>
  );
}

function MissingTaskDetail({ taskId }: { taskId: string }) {
  return (
    <micaUi.Dialog title={`task ${taskId}`} footer={<micaUi.KeyHints hints={['esc back']} />}>
      <Text dimColor wrap="wrap">
        Task details are no longer available.
      </Text>
    </micaUi.Dialog>
  );
}

function TaskListBackgroundRow({
  task,
  selected,
  treePrefix,
}: {
  task: MicaUiBackgroundTaskItem;
  selected: boolean;
  treePrefix: string;
}) {
  return (
    <TaskListRowSurface selected={selected}>
      <micaUi.OneLineItem
        cells={[
          buildStatusMarkerCell(treePrefix, backgroundStatusAppearance(task.status)),
          {
            key: 'title',
            content: `$ ${formatTaskTitle(task.command)}`,
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            color: selected ? micaUi.theme.colors.accent : micaUi.theme.colors.toolShell,
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
  treePrefix,
}: {
  agent: MicaUiAgentStatusItem;
  selected: boolean;
  treePrefix: string;
}) {
  return (
    <TaskListRowSurface selected={selected}>
      <micaUi.OneLineItem cells={buildTaskListAgentCells(agent, selected, treePrefix)} />
    </TaskListRowSurface>
  );
}

function TaskListSubagentRow({
  task,
  selected,
  treePrefix,
}: {
  task: SubagentTaskSummary;
  selected: boolean;
  treePrefix: string;
}) {
  return (
    <TaskListRowSurface selected={selected}>
      <micaUi.OneLineItem
        cells={[
          buildStatusMarkerCell(treePrefix, subagentStatusAppearance(task.status)),
          {
            key: 'title',
            content: formatSubagentListTitle(task),
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            color: selected ? micaUi.theme.colors.accent : undefined,
            bold: selected,
          },
        ]}
      />
    </TaskListRowSurface>
  );
}

export function buildTaskListAgentCells(agent: MicaUiAgentStatusItem, selected: boolean, treePrefix = '') {
  const highlight = selected || agent.current;
  return [
    buildStatusMarkerCell(treePrefix, agentStatusAppearance(agent)),
    {
      key: 'title',
      content: formatAgentListTitle(agent),
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      color: highlight ? micaUi.theme.colors.accent : undefined,
      bold: selected,
    },
  ];
}

function formatAgentListTitle(agent: MicaUiAgentStatusItem): string {
  return `#${agent.index} ${agent.title}`;
}

function isActiveAgentSession(agent: MicaUiAgentStatusItem): boolean {
  return getWorkingStatusDisplay(agent.status).spinning || agent.status.type === 'plugin_task';
}

function formatSubagentListTitle(task: SubagentTaskSummary): string {
  const description = task.description.trim().replace(/\s+/g, ' ') || '(untitled task)';
  return `${task.subagentType} · ${description}`;
}

function formatSubagentTaskAge(task: Pick<SubagentTaskSummary, 'startedAt' | 'finishedAt'>, nowMs: number): string {
  const startedAt = Date.parse(task.startedAt);
  if (Number.isNaN(startedAt)) return 'unknown';
  const finishedAt = task.finishedAt ? Date.parse(task.finishedAt) : nowMs;
  return formatElapsed(Math.max(0, (Number.isNaN(finishedAt) ? nowMs : finishedAt) - startedAt));
}

type TaskStatusAppearance = {
  spinning: boolean;
  glyph: string;
  color: string;
};

function buildStatusMarkerCell(treePrefix: string, appearance: TaskStatusAppearance) {
  return {
    key: 'marker',
    content: <TaskStatusMarker treePrefix={treePrefix} appearance={appearance} />,
    flexShrink: 0,
  };
}

function TaskStatusMarker({ treePrefix, appearance }: { treePrefix: string; appearance: TaskStatusAppearance }) {
  return appearance.spinning ? (
    <SpinningTaskStatusMarker treePrefix={treePrefix} color={appearance.color} />
  ) : (
    <StatusMarkerContent treePrefix={treePrefix} glyph={appearance.glyph} color={appearance.color} />
  );
}

function SpinningTaskStatusMarker({ treePrefix, color }: { treePrefix: string; color: string }) {
  const glyph = micaUi.useSpinner();
  return <StatusMarkerContent treePrefix={treePrefix} glyph={glyph} color={color} />;
}

function StatusMarkerContent({ treePrefix, glyph, color }: { treePrefix: string; glyph: string; color: string }) {
  return (
    <Text>
      {treePrefix ? <Text color={micaUi.theme.colors.textSecondary}>{treePrefix}</Text> : null}
      <Text color={color}>{glyph}</Text>
    </Text>
  );
}

function agentStatusAppearance(agent: MicaUiAgentStatusItem): TaskStatusAppearance {
  const display = getWorkingStatusDisplay(agent.status);
  if (display.spinning) return { spinning: true, glyph: '', color: display.color };
  if (agent.status.type === 'completed') {
    return { spinning: false, glyph: '✓', color: micaUi.theme.colors.statusSuccess };
  }
  if (agent.status.type === 'error') {
    return { spinning: false, glyph: '×', color: micaUi.theme.colors.statusError };
  }
  return { spinning: false, glyph: '○', color: micaUi.theme.colors.inactive };
}

function subagentStatusAppearance(status: SubagentTaskStatus): TaskStatusAppearance {
  if (status === 'running') {
    return { spinning: true, glyph: '', color: micaUi.theme.colors.statusRunning };
  }
  if (status === 'completed') {
    return { spinning: false, glyph: '✓', color: micaUi.theme.colors.statusSuccess };
  }
  if (status === 'failed') {
    return { spinning: false, glyph: '×', color: micaUi.theme.colors.statusError };
  }
  return { spinning: false, glyph: '■', color: micaUi.theme.colors.inactive };
}

function backgroundStatusAppearance(status: MicaUiBackgroundTaskItem['status']): TaskStatusAppearance {
  if (isActiveBackgroundTaskStatus(status)) {
    return { spinning: true, glyph: '', color: micaUi.theme.colors.statusRunning };
  }
  if (status === 'finished') {
    return { spinning: false, glyph: '✓', color: micaUi.theme.colors.statusSuccess };
  }
  if (status === 'failed') {
    return { spinning: false, glyph: '×', color: micaUi.theme.colors.statusError };
  }
  return { spinning: false, glyph: '■', color: micaUi.theme.colors.inactive };
}

function TaskListRowSurface({ selected, children }: { selected: boolean; children: ReactNode }) {
  return (
    <Box width="100%" backgroundColor={selected ? '#3A3A3A' : undefined}>
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

function WrappedDetailLine({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box flexDirection="row" width="100%" minWidth={0}>
      <Box width={14} flexShrink={0}>
        <Text color={micaUi.theme.colors.textSecondary}>{label}</Text>
      </Box>
      <Box flexGrow={1} flexBasis={0} minWidth={0}>
        <Text color={color} wrap="wrap">
          {value}
        </Text>
      </Box>
    </Box>
  );
}

function DetailTextSection({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box flexDirection="column" width="100%" minWidth={0} paddingTop={1}>
      <Text color={micaUi.theme.colors.textSecondary}>{label}</Text>
      <Text color={color} wrap="wrap">
        {value || '(empty)'}
      </Text>
    </Box>
  );
}

function formatSubagentOwner(task: SubagentTaskDetail): string {
  const current = task.owner.current ? ' · current' : '';
  return `#${task.owner.index} ${task.owner.title} · ${task.owner.sessionId}${current}`;
}

function formatStringList(values: readonly string[]): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join('\n') : '(none)';
}

function formatSubagentUsage(task: SubagentTaskDetail): string {
  const usage = task.usage;
  if (!usage) return '(none)';
  return [
    `${usage.records} record${usage.records === 1 ? '' : 's'}`,
    `${formatTokenCount(usage.inputTokens)} input`,
    `${formatTokenCount(usage.outputTokens)} output`,
    `${formatTokenCount(usage.cachedInputTokens)} cached input`,
    `${formatTokenCount(usage.totalTokens)} total`,
  ].join(' · ');
}

function formatSubagentResult(task: SubagentTaskDetail): string {
  if (task.result !== undefined) return task.result || '(empty result)';
  if (task.status === 'running') return 'Result is not available while this task is running.';
  return '(no result)';
}

function truncatePreview(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const notice = `[truncated: showing first ${maxChars.toLocaleString()} of ${value.length.toLocaleString()} characters]`;
  return `${value.slice(0, maxChars)}\n\n${notice}`;
}

function openSelectedTask(
  services: CommandRuntimeServices,
  item: TaskListItem | undefined,
  hide: () => void,
  stateAtom: ReturnType<typeof atom<TaskPanelState>>,
) {
  if (!item) return;
  if (item.kind === 'background') {
    stateAtom.set({ ...stateAtom.get(), detail: { kind: 'background', taskId: item.taskId } });
    return;
  }
  if (item.kind === 'subagent') {
    stateAtom.set({ ...stateAtom.get(), detail: { kind: 'subagent', taskId: item.taskId } });
    return;
  }

  hide();
  try {
    const switched = services.switchAgentSession(item.taskId);
    services.showNotice(`Switched to #${switched.index}: ${switched.title}`, undefined, {
      command: '/task',
      status: 'success',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.showNotice(`Switch failed: ${message}`, undefined, { command: '/task', status: 'error' });
  }
}

function buildTaskListItems(
  backgroundTasks: readonly MicaUiBackgroundTaskItem[],
  agents: readonly MicaUiAgentStatusItem[],
  subagentTasks: readonly SubagentTaskSummary[],
): TaskListItem[] {
  const items: TaskListItem[] = [];
  const matchedSubagentIds = new Set<string>();
  const matchedBackgroundTaskIds = new Set<string>();
  const subagentsByOwner = groupBy(subagentTasks, (task) => task.owner.sessionId);
  const backgroundTasksByOwner = groupBy(backgroundTasks, (task) => task.agentOwnerId ?? '');

  for (const agent of agents) {
    const children: TaskListItem[] = [];
    items.push({
      key: `session:${agent.id}`,
      label: formatAgentListTitle(agent),
      kind: 'session',
      taskId: agent.id,
      searchText: [
        agent.title,
        agent.id,
        agent.index,
        agent.cwd,
        agent.providerName,
        agent.model,
        getWorkingStatusDisplay(agent.status).text,
      ].join('\n'),
      groupId: agent.id,
      treePrefix: '',
    });

    for (const task of subagentsByOwner.get(agent.id) ?? []) {
      matchedSubagentIds.add(task.id);
      children.push(toSubagentListItem(task, agent.id));
    }

    if (agent.taskOwnerId) {
      for (const task of backgroundTasksByOwner.get(agent.taskOwnerId) ?? []) {
        matchedBackgroundTaskIds.add(task.id);
        children.push(toBackgroundListItem(task, agent.id));
      }
    }

    appendTreeChildren(items, children);
  }

  for (const task of subagentTasks) {
    if (!matchedSubagentIds.has(task.id)) {
      items.push(toSubagentListItem(task, `subagent:${task.id}`));
    }
  }
  for (const task of backgroundTasks) {
    if (!matchedBackgroundTaskIds.has(task.id)) {
      items.push(toBackgroundListItem(task, `background:${task.id}`));
    }
  }

  return items;
}

function toSubagentListItem(task: SubagentTaskSummary, groupId: string): TaskListItem {
  const label = formatSubagentListTitle(task);
  return {
    key: `subagent:${task.id}`,
    label,
    kind: 'subagent',
    taskId: task.id,
    searchText: [
      task.description,
      task.subagentType,
      task.id,
      task.model,
      task.status,
      task.effort,
      task.owner.title,
      task.owner.index,
      task.owner.sessionId,
    ].join('\n'),
    groupId,
    treePrefix: '',
  };
}

function toBackgroundListItem(task: MicaUiBackgroundTaskItem, groupId: string): TaskListItem {
  const label = `$ ${formatTaskTitle(task.command)}`;
  return {
    key: `background:${task.id}`,
    label,
    kind: 'background',
    taskId: task.id,
    searchText: [task.command, task.id, task.status, task.cwd, task.shell].join('\n'),
    groupId,
    treePrefix: '',
  };
}

function appendTreeChildren(target: TaskListItem[], children: readonly TaskListItem[]): void {
  const lastIndex = children.length - 1;
  children.forEach((child, index) => {
    target.push({ ...child, treePrefix: index === lastIndex ? '  └─ ' : '  ├─ ' });
  });
}

function filterActiveBackgroundTasks(tasks: readonly MicaUiBackgroundTaskItem[]): readonly MicaUiBackgroundTaskItem[] {
  return tasks.filter((task) => isActiveBackgroundTaskStatus(task.status));
}

function filterTaskListItems(items: TaskListItem[], query: string): TaskListItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return items;
  const matchedGroups = new Set(
    items.filter((item) => item.searchText.toLowerCase().includes(normalizedQuery)).map((item) => item.groupId),
  );
  return items.filter((item) => matchedGroups.has(item.groupId));
}

function groupBy<T>(items: readonly T[], keyFor: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
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
    agentOwnerId: task.agent_owner_id,
  };
}

function loadBackgroundTasks(): MicaUiBackgroundTaskItem[] {
  return listBackgroundTasks({ status: 'all' }).map(toUiBackgroundTask);
}

function loadTaskMeta(id: string): BackgroundTaskMeta | undefined {
  return listBackgroundTasks({ status: 'all' }).find((task) => task.id === id);
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}
