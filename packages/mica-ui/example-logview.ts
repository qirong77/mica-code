#!/usr/bin/env bun

/**
 * Standalone demo: 100 static log items + 1 new item per second + 20 exit commands.
 *
 * Run: bun packages/mica-ui/example-logview.ts
 */

import React from 'react';
import { wrappedRender } from '@anthropic/ink';
import { micaUi } from './index.js';

const h = React.createElement;

// ── 100 static log items ──

const TOOL_NAMES = ['read_file', 'run_shell', 'grep_search', 'web_fetch', 'web_search', 'apply_patch', 'list_files'];
const DISPLAY_TEXTS = [
  'read packages/mica-agent/prompt/system.md',
  'bunx tsc --noEmit',
  'search "createToolCallLogItem" packages/mica-ui -n',
  'fetch https://example.com/docs',
  'search mica-ui agent turn log patterns',
  'apply patch to AgentTurnLog.tsx',
  'list files in packages/mica-ui/bottom',
  'run bun test packages/mica-ui/agentTurnLogItems.test.ts',
  'read packages/mica-ui/panels/state.ts',
  'run prettier --check packages/mica-ui',
  'grep "nanostores" packages/mica-ui -r',
  'fetch https://opencode.ai/zen/v1/models/',
  'search Ink ScrollBox examples',
  'read packages/mica-ui/hooks/useLogViewHeight.ts',
  'run typecheck on packages/mica-ui',
];

function buildLogItems() {
  const items: Array<ReturnType<typeof micaUi.createThinkingLogItem>> = [];

  for (let i = 0; i < 100; i++) {
    if (i % 5 === 0) {
      items.push(
        micaUi.createThinkingLogItem(
          `thinking-${i}`,
          `Processing step ${i + 1}/100 — analyzing code structure and collecting context for the current task.`,
        ),
      );
    } else {
      const toolName = TOOL_NAMES[i % TOOL_NAMES.length] ?? 'read_file';
      const displayText = DISPLAY_TEXTS[i % DISPLAY_TEXTS.length] ?? `some tool call #${i}`;
      items.push(
        micaUi.createToolCallLogItem({
          id: `tool-${i}`,
          toolName,
          displayText,
          completed: true,
          elapsedMs: 120 + (i % 7) * 350,
          output:
            toolName === 'run_shell' ? `[stdout]\nLog entry ${i + 1}: command finished with exit code 0` : undefined,
        }),
      );
    }
  }

  return items;
}

// ── Append one new log item per second ──

let liveCounter = 100;

function buildNextLogItem(): ReturnType<typeof micaUi.createThinkingLogItem> {
  const i = liveCounter++;

  if (i % 5 === 0) {
    return micaUi.createThinkingLogItem(
      `thinking-${i}`,
      `Live item ${i}: continuing analysis — new thinking entry at +${(i - 99) * 1}s.`,
    );
  }

  const toolName = TOOL_NAMES[i % TOOL_NAMES.length] ?? 'read_file';
  const displayText = DISPLAY_TEXTS[i % DISPLAY_TEXTS.length] ?? `live tool call #${i}`;
  return micaUi.createToolCallLogItem({
    id: `tool-${i}`,
    toolName,
    displayText,
    completed: true,
    elapsedMs: 120 + (i % 7) * 350,
    output: toolName === 'run_shell' ? `[stdout]\nLive entry ${i}: command finished with exit code 0` : undefined,
  });
}

// ── 20 exit commands ──

function exitLogview(): void {
  process.exit(0);
}

function registerExitCommands(): void {
  const commands: Array<{ name: string; description: string; action: () => void }> = [];
  for (let i = 1; i <= 100; i++) {
    const suffix = i === 1 ? '' : `-${i}`;
    commands.push({
      name: `exit${suffix}`,
      description: 'exit the example-logview program',
      action: exitLogview,
    });
  }
  micaUi.dropdown.setQuickCommands(commands);
}

// ── Minimal app shell ──

function Root(): React.ReactNode {
  React.useEffect(() => {
    micaUi.dropdown.quickCommand.hide();
    micaUi.bottom.plugins.clear();
    micaUi.conversation.clearResponseText();
    micaUi.conversation.clearPendingInput();
    micaUi.terminalInput.text.set('');
    micaUi.terminalInput.disabled.set(true);
    micaUi.terminalInput.setPlaceholder('example-logview — 20 exit commands · 100 static + 1/s live');
    micaUi.panels.modelDisplay.name.set('example-model');
    micaUi.panels.modelDisplay.effort.set('low');
    micaUi.panels.modelDisplay.contextWindowSize.set(128000);
    micaUi.panels.contextSize.set(25600);
    micaUi.panels.cachedTokenRate.set(0.42);
    micaUi.panels.status.idle();
    micaUi.messageBar.setMessages([{ id: 'logview-ready', text: 'example-logview ready — type /exit to quit' }]);
    micaUi.conversation.setMessages([
      {
        role: 'notice',
        command: '/example-logview',
        content:
          'Log area starts with 100 static items, then appends 1 new entry every second.\n\nType /exit (or /exit-2 … /exit-20) to quit.',
      },
    ]);
    micaUi.bottom.agentTurnLog.setItems(buildLogItems());
    registerExitCommands();

    const timer = setInterval(() => {
      micaUi.bottom.agentTurnLog.appendItem(buildNextLogItem());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  return h(micaUi.App);
}

const instance = await wrappedRender(h(Root));
await instance.waitUntilExit();
