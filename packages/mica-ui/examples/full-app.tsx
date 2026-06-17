#!/usr/bin/env bun
/**
 * mica-ui 综合示例
 *
 * 运行: bun run packages/mica-ui/examples/full-app.tsx
 *
 * 覆盖功能：
 * - App 布局、Conversation、Markdown streaming
 * - TerminalInput 提交、历史输入、pending input
 * - WorkingStatus：connecting / thinking / calling_tool / streaming / completed / error
 * - AgentTurnLog：thinking log、tool log、shell output
 * - MessageBar transient message
 * - PluginPanel
 * - Dropdown quick commands
 *
 * 试试输入：
 * - 普通文本：追加一轮对话
 * - /demo：重新播放完整流程
 * - /plugin：显示插件面板
 * - /message：显示 message bar
 * - /error：显示错误状态
 * - /clear：清空 UI
 */

import React from 'react';
import { wrappedRender, Box, Text } from '@anthropic/ink';
import { micaUI, App } from '../index.js';
import { createThinkingLogItem, createToolCallLogItem } from '../../agent/AgentTurnLogItems.js';

const colors = micaUI.theme.colors;

micaUI.panels.setOnAbortAgent(() => {
  micaUI.panels.status.error('Agent aborted by user');
  micaUI.messageBar.addMessage({ id: `abort-${Date.now()}`, text: 'Agent aborted' });
});

micaUI.dropdown.setQuickCommands([
  { name: 'demo', description: '重新播放完整 UI 流程', action: () => startDemo() },
  { name: 'clear', description: '清空对话、日志和插件面板', action: () => resetDemo() },
  { name: 'plugin', description: '显示一个插件面板', action: () => showPluginPanel(3500) },
  { name: 'message', description: '显示一条 message bar 提示', action: () => showMessage('MessageBar: background task finished') },
  { name: 'error', description: '切换到 error 状态', action: () => micaUI.panels.status.error('Example error from /error') },
  { name: 'help', description: '显示可用命令', action: () => showMessage('Commands: /demo /clear /plugin /message /error /help') },
]);

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

let toolId = 0;
let demoRunId = 0;

function showMessage(text: string, ttl = 3000) {
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  micaUI.messageBar.addMessage({ id, text });
  setTimeout(() => micaUI.messageBar.removeMessage(id), ttl);
}

function resetDemo() {
  demoRunId++;
  toolId = 0;
  micaUI.conversation.clearMessages();
  micaUI.conversation.clearResponseText();
  micaUI.conversation.clearPendingInput();
  micaUI.panels.clearLogEntries();
  micaUI.panels.clearPluginUIs();
  micaUI.messageBar.clearMessages();
  micaUI.panels.status.idle();
  micaUI.terminalInput.setPlaceholder('Type a message or press / for commands...');
}

function addTool(name: string, displayText: string, durationMs: number, output = '') {
  const id = `tool-${++toolId}`;
  micaUI.panels.appendAgentTurnLogItem(createToolCallLogItem({
    id,
    toolName: name,
    displayText,
    output,
    elapsedMs: durationMs,
  }));
}

function addThinking(text: string) {
  micaUI.panels.appendAgentTurnLogItem(createThinkingLogItem(`thinking-${Date.now()}-${Math.random()}`, text));
}

async function showPluginPanel(durationMs = 2500) {
  function PluginContent() {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={colors.info}>┌ Plugin Panel ─────────────────────────────</Text>
        <Text color={colors.dim}>  Plugin: project-inspector</Text>
        <Text color={colors.dim}>  Task: indexing workspace symbols</Text>
        <Text color={colors.dim}>  Progress: ████████░░ 80%</Text>
        <Text color={colors.info}>└───────────────────────────────────────────</Text>
      </Box>
    );
  }
  micaUI.panels.setPluginUIs([{ id: 'demo-plugin', component: PluginContent }]);
  await sleep(durationMs);
  micaUI.panels.clearPluginUIs();
}

async function startDemo() {
  const runId = ++demoRunId;
  resetDemo();
  demoRunId = runId;

  const isCurrent = () => demoRunId === runId;

  showMessage('mica-ui demo started');
  await sleep(500);
  if (!isCurrent()) return;

  micaUI.conversation.setMessages([
    { role: 'user', content: '演示一下 mica-ui 能做什么' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '可以。这个示例会依次演示状态栏、日志、工具调用、插件面板、消息条、Markdown 流式输出和快捷命令。' },
      ],
    },
  ]);
  micaUI.conversation.setPendingInput('等当前 agent 完成后，再发送这条排队输入');

  await sleep(600);
  if (!isCurrent()) return;

  micaUI.panels.status.connecting();
  showMessage('WorkingStatus: connecting');
  await sleep(800);
  if (!isCurrent()) return;

  micaUI.panels.status.thinking();
  addThinking('Thinking: 先展示 AgentTurnLog 的思考记录。');
  await sleep(400);
  addThinking('Thinking: 再展示多个 tool call 和 shell 输出。');
  await sleep(400);
  addThinking('Thinking: 最后流式输出一段 Markdown。');
  await sleep(400);
  if (!isCurrent()) return;

  micaUI.panels.status.callingTool(['list_files'], 0);
  addTool('list_files', 'list_files packages/mica-ui', 720);
  await sleep(900);
  if (!isCurrent()) return;

  micaUI.panels.status.callingTool(['read_file', 'grep_search', 'run_shell'], 1800);
  addTool('read_file', 'read_file packages/mica-ui/index.tsx', 820);
  await sleep(500);
  addTool('grep_search', 'grep_search "micaUI" packages/mica-ui', 640);
  await sleep(500);
  addTool('run_shell', 'bun run check:types', 1600, '$ tsc --noEmit\nDone');
  await sleep(1300);
  if (!isCurrent()) return;

  showPluginPanel(2500);
  showMessage('PluginPanel mounted');
  await sleep(1200);
  if (!isCurrent()) return;

  micaUI.panels.status.streaming();
  micaUI.conversation.clearPendingInput();

  const response =
    '## mica-ui 综合演示\n\n' +
    '这个示例把主要 UI 能力放在一个入口里：\n\n' +
    '| 功能 | 展示方式 |\n' +
    '|------|----------|\n' +
    '| Conversation | 历史消息 + Markdown 渲染 |\n' +
    '| Streaming | `responseText` 逐字更新 |\n' +
    '| WorkingStatus | connecting / thinking / tool / streaming / completed |\n' +
    '| AgentTurnLog | thinking 日志、tool 日志、shell 输出 |\n' +
    '| MessageBar | 顶部临时提示消息 |\n' +
    '| PluginPanel | 动态挂载插件 UI |\n' +
    '| Dropdown | 输入 `/` 后选择 quick command |\n\n' +
    '### 示例代码片段\n\n' +
    '```ts\n' +
    'micaUI.panels.status.streaming();\n' +
    'micaUI.conversation.setResponseText(markdown);\n' +
    'micaUI.panels.appendAgentTurnLogItem(createToolCallLogItem({ id, toolName, displayText }));\n' +
    '```\n\n' +
    '> 输入 `/` 可以打开快捷命令菜单；输入普通文本会追加一轮对话。';

  for (let i = 1; i <= response.length; i++) {
    if (!isCurrent()) return;
    micaUI.conversation.setResponseText(response.slice(0, i));
    await sleep(i < 50 ? 6 : 12);
  }

  await sleep(300);
  if (!isCurrent()) return;
  micaUI.panels.status.completed(8750);

  micaUI.conversation.setMessages([
    { role: 'user', content: '演示一下 mica-ui 能做什么' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '可以。这个示例会依次演示状态栏、日志、工具调用、插件面板、消息条、Markdown 流式输出和快捷命令。' },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: response }] },
  ]);
  micaUI.conversation.clearResponseText();
  showMessage('Demo completed. Press / for commands.');
}

micaUI.terminalInput.onSubmit(async (text) => {
  micaUI.terminalInput.clearText();
  const trimmed = text.trim();
  if (!trimmed) return;

  micaUI.panels.status.thinking();
  micaUI.panels.setAgentTurnLogItems([
    createThinkingLogItem(`input-${Date.now()}`, `Received user input: ${trimmed}`),
  ]);
  micaUI.conversation.appendUserMessage(trimmed);
  micaUI.conversation.setResponseText('');
  await sleep(500);

  const reply = `收到：**${trimmed}**\n\n这是通过 \`terminalInput.onSubmit\` 触发的普通消息回显。输入 \`/\` 可以打开 quick command dropdown。`;
  micaUI.panels.status.streaming();
  for (let i = 1; i <= reply.length; i += 3) {
    micaUI.conversation.setResponseText(reply.slice(0, i));
    await sleep(12);
  }
  micaUI.conversation.appendAssistantMessage([{ type: 'text', text: reply }]);
  micaUI.conversation.clearResponseText();
  micaUI.panels.status.completed(700);
});

setTimeout(() => {
  startDemo();
}, 300);

const instance = await wrappedRender(<App />);
await instance.waitUntilExit();
