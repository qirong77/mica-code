#!/usr/bin/env bun

import { wrappedRender } from '@anthropic/ink';
import {
  micaUi,
  type MicaUiAgentTurnLogItem,
  type MicaUiAgentStatusItem,
  type MicaUiBackgroundTaskItem,
  type MicaUiSubagentTaskItem,
} from '../index.js';
import type { MicaUiSubagentTaskActivity } from '../types.js';

const DEMO_CWD = process.cwd();
const DEMO_TICK_MS = 850;

type DemoStreamEvent =
  | { kind: 'thought'; text: string; taskId: string }
  | { kind: 'tool'; toolName: string; summary: string; output: string; taskId: string };

const DEMO_STREAM_EVENTS: DemoStreamEvent[] = [
  { kind: 'thought', text: '先把规则列表、编辑器、接口类型的边界对齐。', taskId: 'agent-task-1783932834549-7tr8ef' },
  {
    kind: 'tool',
    toolName: 'read_file',
    summary: 'reading packages/rules/api.ts',
    output: 'loaded endpoint signatures and DTO names',
    taskId: 'agent-task-1783932841872-p91c2a',
  },
  {
    kind: 'thought',
    text: '发现保存链路需要把本地草稿和远端 schema 分开处理。',
    taskId: 'agent-task-1783932834549-7tr8ef',
  },
  {
    kind: 'tool',
    toolName: 'grep_search',
    summary: 'searching existing form validation patterns',
    output: 'RuleForm.tsx: validateRuleDraft\nMerchantForm.tsx: validateMerchantPayload',
    taskId: 'agent-task-1783932850000-root2',
  },
  {
    kind: 'thought',
    text: '把校验结果收敛成字段级错误，避免提交失败后整页重置。',
    taskId: 'agent-task-1783932850000-root2',
  },
  {
    kind: 'tool',
    toolName: 'apply_patch',
    summary: 'patching RuleEditor.tsx and ruleDraft.ts',
    output: 'updated draft reducer and submit normalization',
    taskId: 'agent-task-1783932834549-7tr8ef',
  },
  {
    kind: 'thought',
    text: '现在补一条回归路径：编辑草稿、触发校验、修复后再次提交。',
    taskId: 'agent-task-1783932850000-root2',
  },
  {
    kind: 'tool',
    toolName: 'run_shell',
    summary: 'running focused vitest suite',
    output: 'vitest RuleEditor.test.tsx --run\nPASS  drafts survive validation errors',
    taskId: 'agent-task-1783932850000-root2',
  },
];

function seedDemoTasks(nowMs: number): void {
  micaUi.panels.setSubagentTaskItems(createSubagentTasks(nowMs));
  micaUi.panels.setBackgroundTaskItems(createShellTasks(nowMs));
  micaUi.panels.setAgentStatusItems(createAgentSessions(nowMs));
}

function clearDemoTasks(): void {
  micaUi.panels.setSubagentTaskItems([]);
  micaUi.panels.setBackgroundTaskItems([]);
  micaUi.panels.setAgentStatusItems([]);
  micaUi.bottom.agentTurnLog.clear();
  micaUi.panels.status.idle();
}

function startDemoStream(startedAtMs: number): () => void {
  let tick = 0;
  const activitiesByTask = new Map<string, MicaUiSubagentTaskActivity[]>();
  const logItems: MicaUiAgentTurnLogItem[] = [];

  const emit = () => {
    const nowMs = Date.now();
    const event = DEMO_STREAM_EVENTS[tick % DEMO_STREAM_EVENTS.length];
    const activity: MicaUiSubagentTaskActivity = {
      id: `stream-act-${tick}`,
      summary: event.kind === 'thought' ? `thinking: ${event.text}` : event.summary,
      toolName: event.kind === 'tool' ? event.toolName : undefined,
      startedAt: iso(nowMs),
    };
    activitiesByTask.set(event.taskId, [...(activitiesByTask.get(event.taskId) ?? []), activity]);

    if (event.kind === 'thought') {
      logItems.push(micaUi.createThinkingLogItem(`stream-thought-${tick}`, `思考 ${tick + 1}: ${event.text}`));
      micaUi.panels.status.thinking(nowMs, startedAtMs);
    } else {
      logItems.push(
        micaUi.createToolCallLogItem({
          id: `stream-tool-${tick}`,
          toolName: event.toolName,
          displayText: event.summary,
          output: event.output,
          elapsedMs: 350 + (tick % 5) * 180,
        }),
      );
      micaUi.panels.status.callingTool([event.toolName], undefined, nowMs, startedAtMs);
    }

    micaUi.bottom.agentTurnLog.setItems(logItems);
    micaUi.panels.setSubagentTaskItems(createSubagentTasks(nowMs, activitiesByTask));
    micaUi.panels.setBackgroundTaskItems(createShellTasks(nowMs, tick));
    micaUi.panels.setAgentStatusItems(createAgentSessions(nowMs, tick));
    tick += 1;
  };

  emit();
  const timer = setInterval(emit, DEMO_TICK_MS);
  return () => clearInterval(timer);
}

function createSubagentTasks(
  nowMs: number,
  extraActivities: Map<string, MicaUiSubagentTaskActivity[]> = new Map(),
): MicaUiSubagentTaskItem[] {
  return [
    {
      id: 'agent-task-1783932834549-7tr8ef',
      description: '实现商户侧规则中心完整可运行前端',
      subagentType: 'Implementer',
      model: 'gpt-5.4',
      status: 'running',
      startedAt: iso(nowMs - 927_000),
      activities: [
        {
          id: 'act-1',
          summary: 'reading RuleList.tsx',
          toolName: 'read_file',
          startedAt: iso(nowMs - 4_200),
        },
        {
          id: 'act-2',
          summary: 'writing RuleEditor.tsx',
          toolName: 'write_file',
          startedAt: iso(nowMs - 1_800),
        },
        ...(extraActivities.get('agent-task-1783932834549-7tr8ef') ?? []),
      ],
    },
    {
      id: 'agent-task-1783932841872-p91c2a',
      description: '查规则中心接口定义',
      subagentType: 'Explore',
      model: 'gpt-5.4',
      status: 'running',
      parentTaskId: 'agent-task-1783932834549-7tr8ef',
      startedAt: iso(nowMs - 3_700),
      activities: [
        {
          id: 'act-3',
          summary: 'reading api.ts',
          toolName: 'read_file',
          startedAt: iso(nowMs - 900),
        },
        ...(extraActivities.get('agent-task-1783932841872-p91c2a') ?? []),
      ],
    },
    {
      id: 'agent-task-1783932850000-root2',
      description: '补充任务状态同步和 owner 隔离测试',
      subagentType: 'general-purpose',
      model: 'gpt-5.4',
      status: 'running',
      startedAt: iso(nowMs - 2_100),
      activities: extraActivities.get('agent-task-1783932850000-root2') ?? [],
    },
  ];
}

function createShellTasks(nowMs: number, tick = 0): MicaUiBackgroundTaskItem[] {
  return [
    {
      id: '270086-bg-build',
      command: 'bun run build',
      cwd: DEMO_CWD,
      shell: '/bin/bash',
      pid: 270086,
      outputPath: '/tmp/mica-task-build.log',
      outputSize: 18_432 + tick * 384,
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
      outputSize: 512 + tick * 96,
      status: tick > 2 ? 'running' : 'starting',
      startedAt: iso(nowMs - 1_600),
    },
  ];
}

function createAgentSessions(nowMs: number, tick = 0): MicaUiAgentStatusItem[] {
  const activeEvent = DEMO_STREAM_EVENTS[tick % DEMO_STREAM_EVENTS.length];
  const activeTool = activeEvent.kind === 'tool' ? activeEvent.toolName : undefined;

  return [
    {
      id: 'agent-session-2',
      index: 2,
      title: '修复登录超时问题',
      cwd: DEMO_CWD,
      providerName: 'OpenAI',
      model: 'gpt-5.4',
      status: activeTool
        ? { type: 'calling_tool', startedAt: nowMs, toolNames: [activeTool] }
        : { type: 'thinking', startedAt: nowMs },
      current: false,
      startedAt: iso(nowMs - 62_000),
      updatedAt: iso(nowMs),
    },
    {
      id: 'agent-session-3',
      index: 3,
      title: '检查配置加载器回归',
      cwd: DEMO_CWD,
      providerName: 'Anthropic',
      model: 'claude-sonnet-4-6',
      status:
        tick % 3 === 0
          ? { type: 'thinking', startedAt: nowMs }
          : { type: 'calling_tool', startedAt: nowMs, toolNames: ['read_file'] },
      current: false,
      startedAt: iso(nowMs - 28_000),
      updatedAt: iso(nowMs),
    },
  ];
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

const demoStartedAt = Date.now();
seedDemoTasks(demoStartedAt);
const stopDemoStream = startDemoStream(demoStartedAt);
const app = await wrappedRender(<micaUi.App />);

try {
  await app.waitUntilExit();
} finally {
  stopDemoStream();
  clearDemoTasks();
}
