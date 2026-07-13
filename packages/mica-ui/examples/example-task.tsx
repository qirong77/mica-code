#!/usr/bin/env bun

import { wrappedRender } from '@anthropic/ink';
import {
  micaUi,
  type MicaUiAgentStatusItem,
  type MicaUiBackgroundTaskItem,
  type MicaUiSubagentTaskItem,
} from '../index.js';

const DEMO_CWD = process.cwd();

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
      shell: '/bin/bash',
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
      shell: '/bin/bash',
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

seedDemoTasks(Date.now());
const app = await wrappedRender(<micaUi.App />);

try {
  await app.waitUntilExit();
} finally {
  clearDemoTasks();
}
