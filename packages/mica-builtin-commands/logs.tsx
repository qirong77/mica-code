import React, { useEffect, useRef } from 'react';
import { Box, ScrollBox, Text } from '@anthropic/ink';
import type { ScrollBoxHandle } from '@packages/@anthropic/ink/src/components/ScrollBox.js';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaLogger, type RuntimeLogEntry } from '@packages/mica-logger/index.js';
import type { CommandAgent, CommandRuntimeServices } from './services.js';
import { exportCurrentLog } from './logExport.js';

const PANEL_ID = 'logs-panel';
const LOGS_PLACEHOLDER = 'Logs: ↑↓ scroll, Esc close';
const SCROLL_STEP = 4;

let previousPlaceholder: string | null = null;
let scrollBox: ScrollBoxHandle | null = null;

export function createLogCommand(agent: CommandAgent, services: CommandRuntimeServices) {
  return {
    name: 'log',
    description: '展示当前运行日志；/log export 导出对话与日志',
    action: (arg?: string) => {
      if (arg?.trim().toLowerCase() === 'export') {
        closeLogsPanel();
        exportCurrentLog(agent, services);
        return;
      }
      showLogsPanel();
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

export function createLogsCommand(agent: CommandAgent, services: CommandRuntimeServices) {
  return {
    name: 'logs',
    description: '展示当前运行日志',
    hidden: true,
    action: (arg?: string) => {
      if (arg?.trim().toLowerCase() === 'export') {
        closeLogsPanel();
        exportCurrentLog(agent, services);
        return;
      }
      showLogsPanel();
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function showLogsPanel() {
  previousPlaceholder ??= micaUi.terminalInput.placeholder.get();

  function LogsPanel() {
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
      <micaUi.Dialog title={`logs (${logs.length})`} footer={<micaUi.KeyHints hints={['↑↓ scroll', 'esc close']} />}>
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

  micaUi.terminalInput.placeholder.set(LOGS_PLACEHOLDER);
  micaLogger.logRuntime('plugin.logs', 'opened');
  micaUi.panels.setPluginUIs([
    ...micaUi.panels.pluginUIs.get().filter((panel) => panel.id !== PANEL_ID),
    {
      id: PANEL_ID,
      component: LogsPanel,
      preserveInput: true,
      onInput: (_input, key) => {
        if (key.escape) {
          closeLogsPanel();
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

export function closeLogsPanel() {
  const panels = micaUi.panels.pluginUIs.get();
  const wasOpen = panels.some((panel) => panel.id === PANEL_ID);
  const nextPanels = panels.filter((panel) => panel.id !== PANEL_ID);
  micaUi.panels.setPluginUIs(nextPanels);
  restorePlaceholder();
  if (wasOpen) micaLogger.logRuntime('plugin.logs', 'closed');
}

function restorePlaceholder() {
  if (previousPlaceholder == null) return;
  if (micaUi.terminalInput.placeholder.get() === LOGS_PLACEHOLDER) {
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
