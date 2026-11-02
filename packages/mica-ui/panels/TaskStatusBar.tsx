import React, { useEffect, useMemo, useState } from 'react';
import { Box } from '@anthropic/ink';
import { keepsBackgroundTaskRow } from '@packages/mica-common/backgroundTaskVisibility.js';
import { useScheduleState } from '../hooks/index.js';
import { agentStatusItems, backgroundTaskItems, pluginStatusItems, subagentTaskItems } from './state.js';
import { BackgroundTaskRow, isActiveBackgroundTaskStatus } from './BackgroundTaskRow.js';
import { AgentRow } from './AgentRow.js';
import { buildSubagentTaskForest, isActiveSubagentTaskStatus, SubagentTaskRow } from './SubagentTaskRow.js';

export function TaskStatusBar(): React.ReactNode {
  const tasks = useScheduleState(backgroundTaskItems);
  const subagentTasks = useScheduleState(subagentTaskItems);
  const agents = useScheduleState(agentStatusItems);
  const pluginItems = useScheduleState(pluginStatusItems);
  const activeTasks = tasks.filter((task) => isActiveBackgroundTaskStatus(task.status));
  const recentTasks = tasks.filter(
    (task) => !isActiveBackgroundTaskStatus(task.status) && keepsBackgroundTaskRow(task),
  );
  const activeSubagentTasks = subagentTasks.filter((task) => isActiveSubagentTaskStatus(task.status));
  const visibleSubagentTasks = subagentTasks.filter((task) => task.status !== 'completed');
  const backgroundAgents = agents.filter((agent) => !agent.current);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const forest = useMemo(() => buildSubagentTaskForest(visibleSubagentTasks), [visibleSubagentTasks]);

  useEffect(() => {
    if (activeTasks.length === 0 && activeSubagentTasks.length === 0 && backgroundAgents.length === 0) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeTasks.length, activeSubagentTasks.length, backgroundAgents.length]);

  if (
    pluginItems.length === 0 &&
    activeTasks.length === 0 &&
    recentTasks.length === 0 &&
    visibleSubagentTasks.length === 0 &&
    backgroundAgents.length === 0
  ) {
    return null;
  }

  return (
    <Box paddingX={1} flexDirection="column" width="100%" minWidth={0}>
      {pluginItems.map((item) => (
        <item.component key={item.id} />
      ))}
      {forest.roots.map((task) => (
        <SubagentTaskRow key={task.id} task={task} childrenByParent={forest.childrenByParent} nowMs={nowMs} />
      ))}
      {[...activeTasks, ...recentTasks].map((task) => (
        <BackgroundTaskRow key={task.id} task={task} compact nowMs={nowMs} />
      ))}
      {backgroundAgents.map((agent) => (
        <AgentRow key={agent.id} agent={agent} compact nowMs={nowMs} />
      ))}
    </Box>
  );
}

export const TaskStatusBarUI = { renderFn: TaskStatusBar };
