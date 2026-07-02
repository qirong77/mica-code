import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { useEffect, useRef } from 'react';
import { Box, ScrollBox, Text } from '@anthropic/ink';
import type { ScrollBoxHandle } from '@packages/@anthropic/ink/src/components/ScrollBox.js';
import type { AgentUsageRecord } from '@packages/mica-agent/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaLogger, type RuntimeLogEntry } from '@packages/mica-logger/index.js';
import type { CommandAgent, CommandRuntimeServices } from './services.js';
import { BUILD_TIME } from '../../src/buildMeta.js';

const PANEL_ID = 'log-panel';
const LOG_PLACEHOLDER = 'Log: ↑↓ scroll, Esc close';
const SCROLL_STEP = 4;
const MAX_EXPORT_STRING_CHARS = 120_000;
const MAX_EXPORT_DEPTH = 12;
const EXPORT_FILES = [
  'manifest.log',
  'diagnostics.log',
  'runtime.log',
  'runtime-logs.log',
  'turn-log.log',
  'conversation.log',
] as const;

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
    hiddenMenuItems: [{ arg: 'export', description: '导出对话与日志' }],
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
  micaUi.panels.upsertPluginUI({
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
  });
}

export function closeLogPanel() {
  const wasOpen = micaUi.panels.removePluginUI(PANEL_ID);
  restorePlaceholder();
  if (wasOpen) micaLogger.logRuntime('plugin.log', 'closed');
}

function exportCurrentLog(agent: CommandAgent, services: CommandRuntimeServices): void {
  micaLogger.logRuntime('plugin.log', 'export:requested');

  try {
    const snapshot = agent.getSnapshot();
    const rawMessages = snapshot.messages;
    const usageHistory = snapshot.usageHistory;
    const turns = buildTurns(rawMessages, usageHistory);
    const exportedAt = new Date();
    const cwd = process.cwd();
    const exportDirName = `mica-log-export-${formatTimestampForPath(exportedAt)}`;
    const exportDir = resolve(cwd, exportDirName);
    mkdirSync(exportDir, { recursive: false });

    const runtimeLogs = micaLogger.logs.get();
    const agentTurnLogItems = micaUi.panels.agentTurnLogItems.get();
    const pendingInputs = micaUi.conversation.pendingInputs.get();
    const conversationData = {
      exportedAt: exportedAt.toISOString(),
      provider: snapshot.providerId,
      model: snapshot.model,
      effort: snapshot.effort,
      totalMessages: rawMessages.length,
      totalTurns: turns.length,
      turns: turns.map((turn) => ({
        turnIndex: turn.turnIndex,
        model: turn.model,
        usage: turn.usageRecords.map(compactUsage),
        messages: sanitizeExportValue(turn.messages),
      })),
    };
    const runtimeLogData = {
      exportedAt: exportedAt.toISOString(),
      totalEntries: runtimeLogs.length,
      entries: runtimeLogs,
    };
    const turnLogData = {
      exportedAt: exportedAt.toISOString(),
      workingStatus: micaUi.panels.workingStatus.get(),
      thinkingText: micaUi.panels.thinkingText.get(),
      contextSize: micaUi.panels.contextSize.get(),
      cachedTokenRate: micaUi.panels.cachedTokenRate.get(),
      responseText: micaUi.conversation.responseText.get(),
      pendingInputs,
      pendingQueueMode: micaUi.conversation.pendingQueueMode.get(),
      agentTurnLogItems: agentTurnLogItems.map((item) => ({ id: item.id })),
    };
    const diagnostics = {
      exportedAt: exportedAt.toISOString(),
      cwd,
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      bun: process.versions.bun,
      buildTime: BUILD_TIME,
      provider: snapshot.providerId,
      model: snapshot.model,
      effort: snapshot.effort,
      isRunning: agent.isRunning,
      currentRunId: agent.currentRunId,
    };
    const manifest = {
      exportedAt: exportedAt.toISOString(),
      files: [...EXPORT_FILES],
      counts: {
        runtimeLogs: runtimeLogs.length,
        agentTurnLogItems: agentTurnLogItems.length,
        messages: rawMessages.length,
        turns: turns.length,
      },
      notes: [
        'runtime.log/runtime-logs.log contain the bounded in-memory runtime log entries shown by /log.',
        'turn-log.log contains current UI turn state.',
        'conversation.log omits image base64 payloads and truncates very large strings for export safety.',
        'Structured .log files are JSON content with a log-oriented suffix.',
      ],
    };

    writeJsonFile(exportDir, 'manifest.log', manifest);
    writeJsonFile(exportDir, 'diagnostics.log', diagnostics);
    writeFileSync(
      join(exportDir, 'runtime.log'),
      `${runtimeLogs.map((entry) => micaLogger.formatLogEntry(entry)).join('\n')}\n`,
      'utf-8',
    );
    writeJsonFile(exportDir, 'runtime-logs.log', runtimeLogData);
    writeJsonFile(exportDir, 'turn-log.log', sanitizeExportValue(turnLogData));
    writeJsonFile(exportDir, 'conversation.log', conversationData);

    services.showMessage(
      `log export: 已导出 ${rawMessages.length} 条消息、${runtimeLogs.length} 条运行日志 -> ${exportDirName}`,
      8000,
    );
    micaLogger.logRuntime('plugin.log', 'export:done', {
      path: exportDirName,
      messages: rawMessages.length,
      runtimeLogs: runtimeLogs.length,
      turns: turns.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.showMessage(`log export: 导出失败：${message}`, 8000);
    micaLogger.logRuntime('plugin.log', 'export:error', { message }, 'error');
  }
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

function writeJsonFile(dir: string, name: string, data: unknown): void {
  writeFileSync(join(dir, name), `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function formatTimestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function sanitizeExportValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'string') return truncateExportString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[Function omitted]';
  if (typeof value !== 'object') return String(value);
  if (depth > MAX_EXPORT_DEPTH) return '[Max export depth exceeded]';
  if (seen.has(value)) return '[Circular reference omitted]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeExportValue(item, seen, depth + 1));
  }

  if (isImageContentBlock(value)) {
    const result = sanitizePlainObjectWithoutKeys(value, seen, depth, new Set(['source']));
    return {
      ...result,
      source: {
        ...sanitizePlainObject(value.source, seen, depth + 1),
        data: summarizeBase64(value.source.data),
      },
    };
  }

  return sanitizePlainObject(value, seen, depth);
}

function sanitizePlainObject(value: object, seen: WeakSet<object>, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    result[key] = sanitizeExportValue(entryValue, seen, depth + 1);
  }
  return result;
}

function sanitizePlainObjectWithoutKeys(
  value: object,
  seen: WeakSet<object>,
  depth: number,
  omittedKeys: Set<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (omittedKeys.has(key)) continue;
    result[key] = sanitizeExportValue(entryValue, seen, depth + 1);
  }
  return result;
}

function isImageContentBlock(value: object): value is { source: { data: string } } {
  if (!('source' in value)) return false;
  const source = value.source;
  return typeof source === 'object' && source !== null && 'data' in source && typeof source.data === 'string';
}

function summarizeBase64(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `[base64 omitted, chars=${value.length}, sha256=${hash}]`;
}

function truncateExportString(value: string): string {
  if (value.length <= MAX_EXPORT_STRING_CHARS) return value;
  const marker = `\n\n[export truncated, omitted ${value.length - MAX_EXPORT_STRING_CHARS} chars]\n\n`;
  const budget = Math.max(0, MAX_EXPORT_STRING_CHARS - marker.length);
  const head = Math.ceil(budget * 0.65);
  const tail = Math.floor(budget * 0.35);
  return value.slice(0, head) + marker + value.slice(value.length - tail);
}
