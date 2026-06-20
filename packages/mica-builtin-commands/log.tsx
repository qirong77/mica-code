import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useEffect, useRef } from 'react';
import { Box, ScrollBox, Text } from '@anthropic/ink';
import type { ScrollBoxHandle } from '@packages/@anthropic/ink/src/components/ScrollBox.js';
import type { AgentUsageRecord } from '@packages/mica-agent/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaLogger, type RuntimeLogEntry } from '@packages/mica-logger/index.js';
import type { CommandAgent, CommandRuntimeServices } from './services.js';

const PANEL_ID = 'log-panel';
const LOG_PLACEHOLDER = 'Log: ↑↓ scroll, Esc close';
const SCROLL_STEP = 4;

let previousPlaceholder: string | null = null;
let scrollBox: ScrollBoxHandle | null = null;

interface TurnData {
  turnIndex: number;
  model: string | undefined;
  usageRecords: AgentUsageRecord[];
  messages: unknown[];
}

export function createLogCommand(agent: CommandAgent, services: CommandRuntimeServices) {
  return {
    name: 'log',
    description: '展示当前运行日志；/log export 导出对话与日志',
    action: (arg?: string) => {
      if (arg?.trim().toLowerCase() === 'export') {
        closeLogPanel();
        exportCurrentLog(agent, services);
        return;
      }
      showLogPanel();
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function showLogPanel() {
  previousPlaceholder ??= micaUi.terminalInput.placeholder.get();

  function LogPanel() {
    const logs = micaUi.useScheduleState(micaLogger.logs);
    const scrollRef = useRef<ScrollBoxHandle | null>(null);

    useEffect(() => {
      scrollBox = scrollRef.current;
      return () => {
        if (scrollBox === scrollRef.current) scrollBox = null;
      };
    });

    useEffect(() => {
      scrollRef.current?.scrollToBottom();
    }, [logs.length]);

    return (
      <micaUi.Dialog title={`log (${logs.length})`} footer={<micaUi.KeyHints hints={['↑↓ scroll', 'esc close']} />}>
        <ScrollBox ref={scrollRef} height={18} flexDirection="column">
          {logs.length === 0 ? (
            <Text dimColor>no logs</Text>
          ) : (
            <Box flexDirection="column">
              {logs.map((entry) => (
                <Text key={entry.id} color={getLogColor(entry)} dimColor={entry.level === 'debug'}>
                  {micaLogger.formatLogEntry(entry)}
                </Text>
              ))}
            </Box>
          )}
        </ScrollBox>
      </micaUi.Dialog>
    );
  }

  micaUi.terminalInput.placeholder.set(LOG_PLACEHOLDER);
  micaLogger.logRuntime('plugin.log', 'opened');
  micaUi.panels.setPluginUIs([
    ...micaUi.panels.pluginUIs.get().filter((panel) => panel.id !== PANEL_ID),
    {
      id: PANEL_ID,
      component: LogPanel,
      preserveInput: true,
      onInput: (_input, key) => {
        if (key.escape) {
          closeLogPanel();
          return true;
        }
        if (key.upArrow) {
          scrollBox?.scrollBy(-SCROLL_STEP);
          return true;
        }
        if (key.downArrow) {
          scrollBox?.scrollBy(SCROLL_STEP);
          return true;
        }
        return false;
      },
    },
  ]);
}

export function closeLogPanel() {
  const panels = micaUi.panels.pluginUIs.get();
  const wasOpen = panels.some((panel) => panel.id === PANEL_ID);
  const nextPanels = panels.filter((panel) => panel.id !== PANEL_ID);
  micaUi.panels.setPluginUIs(nextPanels);
  restorePlaceholder();
  if (wasOpen) micaLogger.logRuntime('plugin.log', 'closed');
}

function exportCurrentLog(agent: CommandAgent, services: CommandRuntimeServices): void {
  micaLogger.logRuntime('plugin.log', 'export:requested');

  const snapshot = agent.getSnapshot();
  const rawMessages = snapshot.messages;
  const usageHistory = snapshot.usageHistory;

  if (rawMessages.length === 0) {
    services.showMessage('log export: 当前会话为空，无内容可导出', 4000);
    micaLogger.logRuntime('plugin.log', 'export:empty');
    return;
  }

  const turns = buildTurns(rawMessages, usageHistory);

  const conversationData = {
    exportedAt: new Date().toISOString(),
    provider: snapshot.providerId,
    effort: snapshot.effort,
    totalMessages: rawMessages.length,
    totalTurns: turns.length,
    turns: turns.map((turn) => ({
      turnIndex: turn.turnIndex,
      model: turn.model,
      usage: turn.usageRecords.map(compactUsage),
      messages: turn.messages,
    })),
  };

  const logEntries = micaUi.panels.logEntries.get();
  const logData = {
    exportedAt: new Date().toISOString(),
    entries: logEntries.map((entry) => {
      if (entry.type === 'thinking') {
        return { type: 'thinking', text: entry.text };
      }
      return {
        type: 'tool',
        toolName: entry.toolName,
        displayText: entry.displayText,
        output: entry.output,
        completed: entry.completed,
      };
    }),
  };

  const cwd = process.cwd();
  writeFileSync(resolve(cwd, 'conversation.json'), `${JSON.stringify(conversationData, null, 2)}\n`, 'utf-8');
  writeFileSync(resolve(cwd, 'log.text'), `${JSON.stringify(logData, null, 2)}\n`, 'utf-8');

  services.showMessage(
    `log export: 已导出 ${rawMessages.length} 条消息 (${turns.length} turns) -> conversation.json, log.text`,
    6000,
  );
  micaLogger.logRuntime('plugin.log', 'export:done', { messages: rawMessages.length, turns: turns.length });
}

function restorePlaceholder() {
  if (previousPlaceholder == null) return;
  if (micaUi.terminalInput.placeholder.get() === LOG_PLACEHOLDER) {
    micaUi.terminalInput.placeholder.set(previousPlaceholder);
  }
  previousPlaceholder = null;
}

function getLogColor(entry: RuntimeLogEntry) {
  if (entry.level === 'error') return micaUi.theme.colors.error;
  if (entry.level === 'warn') return micaUi.theme.colors.warning;
  if (entry.level === 'debug') return micaUi.theme.colors.dim;
  return undefined;
}

function buildTurns(messages: unknown[], usageHistory: AgentUsageRecord[]): TurnData[] {
  const turns: TurnData[] = [];
  let currentTurnMessages: unknown[] = [];

  for (const message of messages) {
    if (isUserMessage(message) && currentTurnMessages.length > 0) {
      turns.push(makeTurn(turns.length + 1, currentTurnMessages, usageHistory));
      currentTurnMessages = [];
    }
    currentTurnMessages.push(message);
  }

  if (currentTurnMessages.length > 0) {
    turns.push(makeTurn(turns.length + 1, currentTurnMessages, usageHistory));
  }

  return turns;
}

function makeTurn(turnIndex: number, messages: unknown[], usageHistory: AgentUsageRecord[]): TurnData {
  const turnUsages = usageHistory.filter((usage) => usage.turnId === turnIndex);
  const model = turnUsages.length > 0 ? turnUsages[0].model : undefined;

  return {
    turnIndex,
    model,
    usageRecords: turnUsages,
    messages,
  };
}

function isUserMessage(message: unknown): boolean {
  return typeof message === 'object' && message !== null && 'role' in message && message.role === 'user';
}

function compactUsage(usage: AgentUsageRecord) {
  return {
    model: usage.model,
    requestIndex: usage.requestIndex,
    messageCount: usage.messageCount,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    paidTokenRate: usage.paidTokenRate,
  };
}
