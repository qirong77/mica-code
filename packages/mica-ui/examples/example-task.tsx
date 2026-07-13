#!/usr/bin/env bun

import React, { useEffect } from 'react';
import { Box, Text, useTerminalTitle, wrappedRender } from '@anthropic/ink';
import {
  micaUi,
  type MicaUiAgentStatusItem,
  type MicaUiBackgroundTaskItem,
  type MicaUiSubagentTaskItem,
} from '../index.js';

const DEMO_CWD = process.cwd();

function ExampleTaskApp(): React.ReactNode {
  useTerminalTitle('Mica UI · Background tasks');

  useEffect(() => {
    seedDemoTasks(Date.now());
    return clearDemoTasks;
  }, []);

  return (
    <Box flexDirection="column" paddingY={1} width="100%">
      <Box flexDirection="column" paddingX={2}>
        <Text bold>Background task UI</Text>
        <Text dimColor>Production TaskStatusBar with subagents, shell tasks, and background agent sessions.</Text>
      </Box>

      <micaUi.TaskStatusBar />

      <Box paddingX={1} paddingTop={1}>
        <Box borderStyle="round" borderColor={micaUi.theme.colors.borderInput} paddingX={1} width="100%">
          <Text color={micaUi.theme.colors.accent}>› </Text>
          <Text dimColor>Type a message...</Text>
        </Box>
      </Box>

      <Box paddingX={2} paddingTop={1}>
        <Text dimColor>Elapsed times update automatically · Press Ctrl+C to exit</Text>
      </Box>
    </Box>
  );
}

function seedDemoTasks(nowMs: number): void {
  micaUi.panels.setSubagentTaskItems(createSubagentTasks(nowMs));
  micaUi.panels.setBackgroundTaskItems(createShellTasks(nowMs));
  micaUi.panels.setAgentStatusItems(createAgentSessions(nowMs));
}

function clearDemoTasks(): void {
  micaUi.panels.setSubagentTaskItems([]);
  micaUi.panels.setBackgroundTaskItems([]);
  micaUi.panels.setAgentStatusItems([]);
}

function createSubagentTasks(nowMs: number): MicaUiSubagentTaskItem[] {
  return [
    {
      id: 'agent-task-1783932834549-7tr8ef',
      description: '梳理后台任务 UI 与 session 状态链路',
      subagentType: 'Explore',
      model: 'gpt-5.4',
      status: 'running',
      startedAt: iso(nowMs - 8_200),
    },
    {
      id: 'agent-task-1783932841872-p91c2a',
      description: '补充任务状态同步和 owner 隔离测试',
      subagentType: 'general-purpose',
      model: 'gpt-5.4',
      status: 'running',
      startedAt: iso(nowMs - 3_700),
    },
  ];
}

function createShellTasks(nowMs: number): MicaUiBackgroundTaskItem[] {
  return [
    {
      id: '270086-bg-build',
      command: 'bun run build',
      cwd: DEMO_CWD,
      shell: '/bin/zsh',
      pid: 270086,
      outputPath: '/tmp/mica-task-build.log',
      outputSize: 18_432,
      status: 'running',
      startedAt: iso(nowMs - 12_400),
    },
    {
      id: '270117-bg-server',
      command: 'bun run dev',
      cwd: DEMO_CWD,
      shell: '/bin/zsh',
      pid: 270117,
      outputPath: '/tmp/mica-task-server.log',
      outputSize: 512,
      status: 'starting',
      startedAt: iso(nowMs - 1_600),
    },
  ];
}

function createAgentSessions(nowMs: number): MicaUiAgentStatusItem[] {
  return [
    {
      id: 'agent-session-2',
      index: 2,
      title: '修复登录超时问题',
      cwd: DEMO_CWD,
      providerName: 'OpenAI',
      model: 'gpt-5.4',
      status: { type: 'thinking', startedAt: nowMs - 4_100 },
      current: false,
      startedAt: iso(nowMs - 62_000),
      updatedAt: iso(nowMs - 1_000),
    },
    {
      id: 'agent-session-3',
      index: 3,
      title: '检查配置加载器回归',
      cwd: DEMO_CWD,
      providerName: 'Anthropic',
      model: 'claude-sonnet-4-6',
      status: { type: 'calling_tool', startedAt: nowMs - 2_800, toolNames: ['read_file'] },
      current: false,
      startedAt: iso(nowMs - 28_000),
      updatedAt: iso(nowMs - 800),
    },
  ];
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

const app = await wrappedRender(<ExampleTaskApp />);
await app.waitUntilExit();
