#!/usr/bin/env bun

import React, { useEffect } from 'react';
import { Box, Text, wrappedRender } from '@anthropic/ink';
import { micaUi } from './index.js';
import type { MicaUiAgentStatusItem, MicaUiCommand } from './types.js';

type QueueMode = 'after_iteration' | 'after_turn';
type SubmitOptions = { queueMode?: QueueMode; displayText?: string };

const h = React.createElement;
const Dialog = micaUi.Dialog as React.ComponentType<any>;
const SelectList = micaUi.SelectList as React.ComponentType<any>;

let renderInstance: Awaited<ReturnType<typeof wrappedRender>> | null = null;
let disposeSubmitHandler: (() => void) | null = null;

const timeouts = new Set<ReturnType<typeof setTimeout>>();
const intervals = new Set<ReturnType<typeof setInterval>>();

const STREAM_RESPONSE = [
  'This response is streamed into `conversation.responseText` before it is committed as an assistant message.',
  '',
  '- `Conversation` renders user, assistant, notice, pending, and live response content.',
  '- `WorkingStatus` reflects connecting, thinking, streaming, tool, plugin, completed, and error states.',
  '- `BottomSurface` switches between command dropdowns, plugin panels, and agent turn logs.',
  '- `TerminalInputUI` owns multiline editing, slash commands, queue shortcuts, and exit handling.',
].join('\n');

function DemoRoot(): React.ReactNode {
  useEffect(() => {
    initializeDemo();
    scheduleTimeout(runStreamDemo, 800);
    return disposeDemo;
  }, []);

  return h(micaUi.App);
}

function initializeDemo(): void {
  installDemoHandlers();
  seedDemoState();
}

function installDemoHandlers(): void {
  disposeSubmitHandler?.();
  disposeSubmitHandler = micaUi.terminalInput.onSubmit(handleSubmit);
  micaUi.terminalInput.setOnExitRequested(exitExample);
  micaUi.panels.setOnAbortAgent(abortCurrentDemoTurn);
  micaUi.panels.setOnEditPendingInput(() => {
    const pending = micaUi.conversation.pendingInput.get();
    micaUi.conversation.clearPendingInput();
    micaUi.panels.status.idle();
    return pending;
  });
  micaUi.dropdown.setQuickCommands(createDemoCommands());
}

function seedDemoState(): void {
  micaUi.dropdown.quickCommand.hide();
  micaUi.bottom.plugins.clear();
  micaUi.conversation.clearResponseText();
  micaUi.conversation.clearPendingInput();
  micaUi.terminalInput.text.set('');
  micaUi.terminalInput.disabled.set(false);
  micaUi.terminalInput.setPlaceholder('Type / to open commands, or type a message');
  micaUi.panels.thinkingText.set('');
  micaUi.panels.modelDisplay.name.set('example-sonnet');
  micaUi.panels.modelDisplay.effort.set('medium');
  micaUi.panels.modelDisplay.contextWindowSize.set(128000);
  micaUi.panels.contextSize.set(38200);
  micaUi.panels.cachedTokenRate.set(0.58);
  micaUi.panels.status.idle();
  micaUi.panels.setAgentStatusItems(makeAgentStatuses(0));
  micaUi.conversation.setMessages([
    {
      role: 'notice',
      command: '/example',
      content: [
        'mica-ui example is running.',
        '',
        'Open the slash command dropdown with `/`, or run `/demo stream`, `/demo tools`, `/demo plugin`, `/demo agents`, `/demo queue`, `/demo image`, `/demo error`, and `/reset`.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: 'Show me the terminal UI surfaces in one compact example.',
    },
    {
      role: 'assistant',
      content:
        'Loaded the main stores and components: conversation, input, working status, message bar, command dropdown, bottom panels, agent status rows, and primitives.',
    },
    {
      role: 'notice',
      variant: 'recap',
      command: '/recap',
      content: 'This notice uses the recap presentation variant to show how command output can be styled differently.',
    },
  ]);
  micaUi.bottom.agentTurnLog.setItems([
    micaUi.createThinkingLogItem('seed-thinking', 'Seeded conversation and UI stores for the demo.'),
    micaUi.createToolCallLogItem({
      id: 'seed-tool',
      toolName: 'read_file',
      displayText: 'read packages/mica-ui/index.ts',
      completed: true,
      elapsedMs: 420,
    }),
  ]);
  micaUi.messageBar.setMessages([
    { id: 'example-ready', text: 'mica-ui example ready' },
    { id: 'example-command', text: 'type / to inspect the command dropdown' },
  ]);
}

function createDemoCommands(): MicaUiCommand[] {
  const demoMenu = [
    { arg: 'stream', label: 'demo stream', description: 'simulate a streaming assistant turn' },
    { arg: 'tools', label: 'demo tools', description: 'show agent turn log items' },
    { arg: 'plugin', label: 'demo plugin', description: 'open a plugin panel using primitives' },
    { arg: 'agents', label: 'demo agents', description: 'animate background agent rows' },
    { arg: 'queue', label: 'demo queue', description: 'render queued pending input' },
    { arg: 'image', label: 'demo image', description: 'show parseImageRefs output' },
    { arg: 'error', label: 'demo error', description: 'show error status and notice' },
  ];

  return [
    {
      name: 'demo',
      description: 'run a mica-ui demo scene',
      hiddenMenuItems: demoMenu,
      action: (arg) => runDemoCommand(arg ?? 'stream'),
    },
    { name: 'stream', description: 'simulate streaming response text', action: runStreamDemo },
    { name: 'tools', description: 'show thinking and tool-call logs', action: runToolsDemo },
    { name: 'plugin', description: 'open a custom plugin panel', action: runPluginDemo },
    {
      name: 'dropdown',
      description: 'keep the command dropdown open',
      action: () => micaUi.dropdown.quickCommand.show(''),
    },
    { name: 'agents', description: 'animate multi-agent status rows', action: runAgentsDemo },
    { name: 'queue', description: 'show queued pending input', action: runQueueDemo },
    { name: 'image', description: 'demonstrate parseImageRefs', action: runImageParseDemo },
    { name: 'error', description: 'show error UI state', action: runErrorDemo },
    { name: 'reset', description: 'reset the example state', action: resetDemo },
    { name: 'exit', description: 'exit the example', action: exitExample },
  ];
}

function runDemoCommand(arg: string): void {
  const scene = arg.trim().split(/\s+/)[0] || 'stream';
  switch (scene) {
    case 'stream':
      runStreamDemo();
      break;
    case 'tools':
      runToolsDemo();
      break;
    case 'plugin':
      runPluginDemo();
      break;
    case 'agents':
      runAgentsDemo();
      break;
    case 'queue':
      runQueueDemo();
      break;
    case 'image':
      runImageParseDemo();
      break;
    case 'error':
      runErrorDemo();
      break;
    default:
      micaUi.messageBar.addMessage({ id: `unknown-demo-${Date.now()}`, text: `unknown demo scene: ${scene}` });
      micaUi.dropdown.quickCommand.show('demo ');
      break;
  }
}

function handleSubmit(text: string, options?: SubmitOptions): void {
  if (options?.queueMode) {
    micaUi.conversation.setPendingInput(options.displayText ?? text, options.queueMode);
    micaUi.messageBar.addMessage({ id: `queued-${Date.now()}`, text: `queued input for ${options.queueMode}` });
    return;
  }

  if (text.startsWith('/')) {
    handleSlashSubmit(text);
    return;
  }

  micaUi.conversation.appendUserMessage(text);
  micaUi.conversation.appendAssistantMessage(
    `Echo from the example runtime: ${text}\n\nUse slash commands to switch UI scenes without a real provider.`,
  );
  micaUi.panels.status.completed(180);
  micaUi.messageBar.addMessage({ id: `echo-${Date.now()}`, text: 'message appended to conversation' });
}

function handleSlashSubmit(text: string): void {
  const [name = '', ...rest] = text.slice(1).trim().split(/\s+/);
  if (!name) {
    micaUi.dropdown.quickCommand.show('');
    return;
  }

  const command = createDemoCommands().find((item) => item.name === name);
  if (!command) {
    micaUi.messageBar.addMessage({ id: `unknown-command-${Date.now()}`, text: `unknown command: /${name}` });
    return;
  }

  void command.action(rest.join(' ') || undefined);
}

function runStreamDemo(): void {
  clearDemoTimers();
  micaUi.dropdown.quickCommand.hide();
  micaUi.bottom.plugins.clear();
  micaUi.conversation.clearPendingInput();
  micaUi.conversation.clearResponseText();

  const startedAt = Date.now();
  micaUi.panels.thinkingText.set('Planning how to update the demo UI stores.');
  micaUi.panels.status.thinking(startedAt);
  micaUi.conversation.appendUserMessage('Run the streaming demo scene.');
  micaUi.bottom.agentTurnLog.setItems([
    micaUi.createThinkingLogItem('stream-thinking', 'Plan: status updates, tool log, live markdown, commit message.'),
    micaUi.createToolCallLogItem({
      id: 'stream-tool',
      toolName: 'read_file',
      displayText: 'read packages/mica-ui/README.md',
      completed: false,
      startTime: startedAt,
    }),
  ]);

  scheduleTimeout(() => {
    const elapsedMs = Date.now() - startedAt;
    micaUi.panels.status.callingTool(['read_file'], elapsedMs, startedAt);
    micaUi.bottom.agentTurnLog.replaceItem(
      micaUi.createToolCallLogItem({
        id: 'stream-tool',
        toolName: 'read_file',
        displayText: 'read packages/mica-ui/README.md',
        completed: true,
        elapsedMs,
      }),
    );
  }, 700);

  scheduleTimeout(() => {
    const chunks = splitForStreaming(STREAM_RESPONSE);
    let index = 0;
    micaUi.panels.status.streaming(startedAt);
    const interval = scheduleInterval(() => {
      index += 1;
      micaUi.conversation.setResponseText(chunks.slice(0, index).join(''));

      if (index < chunks.length) return;

      clearDemoInterval(interval);
      const elapsedMs = Date.now() - startedAt;
      micaUi.conversation.clearResponseText();
      micaUi.conversation.appendAssistantMessage(STREAM_RESPONSE);
      micaUi.panels.status.completed(elapsedMs, startedAt);
      micaUi.bottom.agentTurnLog.appendItem(
        micaUi.createToolCallLogItem({
          id: `stream-shell-${Date.now()}`,
          toolName: 'run_shell',
          displayText: 'bunx tsc --noEmit --pretty false',
          completed: true,
          elapsedMs: 2600,
          output: '[stdout]\nType check completed for the simulated demo run.',
        }),
      );
      micaUi.messageBar.addMessage({ id: `stream-complete-${Date.now()}`, text: 'stream demo completed' });
      scheduleTimeout(() => micaUi.panels.status.idle(), 1500);
    }, 45);
  }, 1200);
}

function runToolsDemo(): void {
  clearDemoTimers();
  micaUi.dropdown.quickCommand.hide();
  micaUi.bottom.plugins.clear();
  const startedAt = Date.now() - 4800;
  const activeStartedAt = Date.now() - 900;
  micaUi.panels.status.callingTool(['grep_search', 'run_shell'], 4800, startedAt);
  micaUi.bottom.agentTurnLog.setItems([
    micaUi.createThinkingLogItem('tools-thinking', 'Inspect the package API and summarize visible surfaces.'),
    micaUi.createToolCallLogItem({
      id: 'tools-grep',
      toolName: 'grep_search',
      displayText: 'search exported mica-ui symbols',
      completed: true,
      elapsedMs: 310,
    }),
    micaUi.createToolCallLogItem({
      id: 'tools-shell',
      toolName: 'run_shell',
      displayText: 'bun run packages/mica-ui/example.ts',
      completed: true,
      elapsedMs: 3400,
      output: '[stdout]\nMounted App\nUpdated conversation stores\nRendered bottom surface',
    }),
    micaUi.createToolCallLogItem({
      id: 'tools-active',
      toolName: 'web_search',
      displayText: 'simulate a running network tool',
      completed: false,
      startTime: activeStartedAt,
    }),
  ]);
  micaUi.messageBar.addMessage({ id: `tools-${Date.now()}`, text: 'agent turn log demo loaded' });

  scheduleTimeout(() => {
    const activeElapsedMs = Date.now() - activeStartedAt;
    const totalElapsedMs = Date.now() - startedAt;
    micaUi.bottom.agentTurnLog.replaceItem(
      micaUi.createToolCallLogItem({
        id: 'tools-active',
        toolName: 'web_search',
        displayText: 'simulate a running network tool',
        completed: true,
        elapsedMs: activeElapsedMs,
      }),
    );
    micaUi.panels.status.completed(totalElapsedMs, startedAt);
    micaUi.messageBar.addMessage({ id: `tools-complete-${Date.now()}`, text: 'agent turn log demo completed' });
    scheduleTimeout(() => micaUi.panels.status.idle(), 1200);
  }, 1800);
}

function runPluginDemo(): void {
  clearDemoTimers();
  micaUi.dropdown.quickCommand.hide();
  micaUi.panels.status.pluginTask('example plugin panel active', 'info');
  micaUi.panels.setExclusivePluginUI({
    id: 'example-plugin-panel',
    component: DemoPluginPanel,
    preserveInput: true,
    onInput: (_input, key) => {
      if (key.escape) {
        micaUi.bottom.plugins.clear();
        micaUi.panels.status.idle();
        return true;
      }
      if (key.return) {
        micaUi.messageBar.addMessage({ id: `plugin-enter-${Date.now()}`, text: 'plugin panel received Enter' });
        return true;
      }
      return false;
    },
  });
  micaUi.messageBar.addMessage({ id: `plugin-${Date.now()}`, text: 'plugin panel opened' });
}

function DemoPluginPanel(): React.ReactNode {
  const items = [
    { key: 'dialog', label: 'Dialog', description: 'framed plugin content surface', status: '[ui]' },
    {
      key: 'select',
      label: 'SelectList',
      description: 'table, detail, highlight, and scroll-ready list primitive',
      status: '[ui]',
    },
    { key: 'one-line', label: 'OneLineItem', description: 'stable columns for compact rows', status: '[ui]' },
    { key: 'spin', label: 'Spin', description: 'shared loading indicator', status: '[ui]' },
  ];

  return h(
    Dialog,
    {
      title: 'Example plugin panel',
      footer: h(micaUi.KeyHints, { hints: ['Esc close', 'Enter toast', '/reset clear'] }),
    },
    h(SelectList, {
      items,
      selectedIdx: 1,
      layout: 'detail',
      showIndex: true,
      maxVisibleItems: 4,
      adaptiveHeight: false,
      highlightText: 'list',
    }),
    h(
      Box,
      { paddingTop: 1, flexDirection: 'row' },
      h(micaUi.Spin, { delay: 120 }),
      h(Text, { dimColor: true }, 'plugin UI can own the bottom surface while preserving terminal input'),
    ),
  );
}

function runAgentsDemo(): void {
  clearDemoTimers();
  micaUi.dropdown.quickCommand.hide();
  micaUi.bottom.plugins.clear();
  let tick = 0;
  micaUi.panels.status.pluginTask('background agents updating', 'info');
  micaUi.panels.setAgentStatusItems(makeAgentStatuses(tick));
  scheduleInterval(() => {
    tick += 1;
    micaUi.panels.setAgentStatusItems(makeAgentStatuses(tick));
  }, 1000);
  micaUi.messageBar.addMessage({ id: `agents-${Date.now()}`, text: 'multi-agent status bar demo running' });
}

function runQueueDemo(): void {
  clearDemoTimers();
  micaUi.dropdown.quickCommand.hide();
  micaUi.bottom.plugins.clear();
  micaUi.panels.status.thinking(Date.now());
  micaUi.conversation.setPendingInputs(
    ['queued after this turn: summarize the current UI state', 'queued after this turn: then open the tools scene'],
    'after_turn',
  );
  micaUi.terminalInput.text.set('Type here, then press Tab to queue while the demo is busy');
  micaUi.messageBar.addMessage({ id: `queue-${Date.now()}`, text: 'pending input queue demo loaded' });
}

function runImageParseDemo(): void {
  clearDemoTimers();
  micaUi.dropdown.quickCommand.hide();
  micaUi.bottom.plugins.clear();
  const parsed = micaUi.parseImageRefs('Here is an image reference: [Image](./packages/mica-ui/README.md)');
  const summary =
    typeof parsed === 'string'
      ? parsed
      : parsed.map((block) => (block.type === 'text' ? block.text : block.source.media_type));
  micaUi.conversation.appendNoticeMessage(
    ['parseImageRefs result:', '', '```json', JSON.stringify(summary, null, 2), '```'].join('\n'),
    { command: '/image' },
  );
  micaUi.panels.status.completed(90);
  micaUi.messageBar.addMessage({ id: `image-${Date.now()}`, text: 'image reference parser demo appended' });
}

function runErrorDemo(): void {
  clearDemoTimers();
  micaUi.dropdown.quickCommand.hide();
  micaUi.bottom.plugins.clear();
  micaUi.panels.status.error('simulated provider timeout');
  micaUi.conversation.appendNoticeMessage(
    'Simulated provider timeout. The UI can keep the conversation readable while status and notices show the failure.',
    { variant: 'error', command: '/error' },
  );
  micaUi.messageBar.addMessage({ id: `error-${Date.now()}`, text: 'simulated error state' });
}

function resetDemo(): void {
  clearDemoTimers();
  seedDemoState();
  micaUi.messageBar.addMessage({ id: `reset-${Date.now()}`, text: 'example state reset' });
}

function abortCurrentDemoTurn(): void {
  clearDemoTimers();
  const partial = micaUi.conversation.responseText.get();
  if (partial) {
    micaUi.conversation.clearResponseText();
    micaUi.conversation.appendAssistantMessage(`${partial}\n\n[aborted by example]`);
  }
  micaUi.panels.status.error('aborted');
  micaUi.messageBar.addMessage({ id: `abort-${Date.now()}`, text: 'demo turn aborted' });
  scheduleTimeout(() => micaUi.panels.status.idle(), 1200);
}

function makeAgentStatuses(tick: number): MicaUiAgentStatusItem[] {
  const now = Date.now();
  const startedAt = new Date(now - 8 * 60 * 1000).toISOString();
  const updatedAt = new Date(now - (tick % 5) * 1000).toISOString();
  const running = tick > 0 && tick % 2 === 0;

  return [
    {
      id: 'current',
      index: 1,
      title: 'main example',
      cwd: process.cwd(),
      providerName: 'Example Provider',
      model: 'example-sonnet',
      status: { type: 'idle' },
      current: true,
      startedAt,
      updatedAt,
    },
    {
      id: 'reviewer',
      index: 2,
      title: 'reviewer',
      cwd: `${process.cwd()}/packages/mica-ui`,
      providerName: 'Example Provider',
      model: 'example-haiku',
      status: running ? { type: 'thinking', startedAt: now - 12000 } : { type: 'completed', elapsedMs: 12800 },
      current: false,
      startedAt,
      updatedAt,
    },
    {
      id: 'builder',
      index: 3,
      title: 'background builder',
      cwd: `${process.cwd()}/packages/mica-tools`,
      providerName: 'Example Provider',
      model: 'example-opus',
      status: running ? { type: 'calling_tool', startedAt: now - 7000, toolNames: ['run_shell'] } : { type: 'idle' },
      current: false,
      startedAt,
      updatedAt,
    },
  ];
}

function splitForStreaming(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

function scheduleTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const timeout = setTimeout(() => {
    timeouts.delete(timeout);
    fn();
  }, ms);
  timeouts.add(timeout);
  return timeout;
}

function scheduleInterval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
  const interval = setInterval(fn, ms);
  intervals.add(interval);
  return interval;
}

function clearDemoInterval(interval: ReturnType<typeof setInterval>): void {
  clearInterval(interval);
  intervals.delete(interval);
}

function clearDemoTimers(): void {
  for (const timeout of timeouts) clearTimeout(timeout);
  for (const interval of intervals) clearInterval(interval);
  timeouts.clear();
  intervals.clear();
}

function disposeDemo(): void {
  clearDemoTimers();
  disposeSubmitHandler?.();
  disposeSubmitHandler = null;
  micaUi.terminalInput.setOnExitRequested(null);
  micaUi.dropdown.quickCommand.hide();
  micaUi.bottom.plugins.clear();
}

function exitExample(): void {
  disposeDemo();
  renderInstance?.unmount();
  process.exit(0);
}

renderInstance = await wrappedRender(h(DemoRoot), { exitOnCtrlC: false });
await renderInstance.waitUntilExit();
