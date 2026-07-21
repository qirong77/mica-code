import React, { useEffect, useMemo, useState } from 'react';
import { Box } from '@anthropic/ink';
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
  const activeSubagentTasks = subagentTasks.filter((task) => isActiveSubagentTaskStatus(task.status));
  const backgroundAgents = agents.filter((agent) => !agent.current);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const forest = useMemo(() => buildSubagentTaskForest(activeSubagentTasks), [activeSubagentTasks]);

  useEffect(() => {
    if (activeTasks.length === 0 && activeSubagentTasks.length === 0 && backgroundAgents.length === 0) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeTasks.length, activeSubagentTasks.length, backgroundAgents.length]);

  if (
    pluginItems.length === 0 &&
    activeTasks.length === 0 &&
    activeSubagentTasks.length === 0 &&
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
      {activeTasks.map((task) => (
        <BackgroundTaskRow key={task.id} task={task} compact nowMs={nowMs} />
      ))}
      {backgroundAgents.map((agent) => (
        <AgentRow key={agent.id} agent={agent} compact nowMs={nowMs} />
      ))}
    </Box>
  );
}

export const TaskStatusBarUI = { renderFn: TaskStatusBar };
