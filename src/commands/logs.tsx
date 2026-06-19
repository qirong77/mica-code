import React, { useEffect, useRef } from 'react';
import { Box, ScrollBox, Text } from '@anthropic/ink';
import type { ScrollBoxHandle } from '../../packages/@anthropic/ink/src/components/ScrollBox.js';
import { micaUI } from '../../packages/mica-ui/index.js';
import { formatLogEntry, logRuntime, runtimeLogs, type RuntimeLogEntry } from '../logger.js';

const PANEL_ID = 'logs-panel';
const LOGS_PLACEHOLDER = 'Logs: ↑↓ scroll, Esc close';
const SCROLL_STEP = 4;

let previousPlaceholder: string | null = null;
let scrollBox: ScrollBoxHandle | null = null;

export function registerLogsPlugin() {
  return {
    name: 'logs',
    description: '展示当前运行日志',
    action: () => {
      showLogsPanel();
    },
  } satisfies Parameters<typeof micaUI.dropdown.setQuickCommands>[0][number];
}

function showLogsPanel() {
  previousPlaceholder ??= micaUI.terminalInput.placeholder.get();

  function LogsPanel() {
    const logs = micaUI.useScheduleState(runtimeLogs);
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
      <micaUI.Dialog title={`logs (${logs.length})`} footer={<micaUI.KeyHints hints={['↑↓ scroll', 'esc close']} />}>
        <ScrollBox ref={scrollRef} height={18} flexDirection="column">
          {logs.length === 0 ? (
            <Text dimColor>no logs</Text>
          ) : (
            <Box flexDirection="column">
              {logs.map((entry) => (
                <Text key={entry.id} color={getLogColor(entry)} dimColor={entry.level === 'debug'}>
                  {formatLogEntry(entry)}
                </Text>
              ))}
            </Box>
          )}
        </ScrollBox>
      </micaUI.Dialog>
    );
  }

  micaUI.terminalInput.placeholder.set(LOGS_PLACEHOLDER);
  logRuntime('plugin.logs', 'opened');
  micaUI.panels.setPluginUIs([
    ...micaUI.panels.pluginUIs.get().filter((panel) => panel.id !== PANEL_ID),
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
  const panels = micaUI.panels.pluginUIs.get();
  const wasOpen = panels.some((panel) => panel.id === PANEL_ID);
  const nextPanels = panels.filter((panel) => panel.id !== PANEL_ID);
  micaUI.panels.setPluginUIs(nextPanels);
  restorePlaceholder();
  if (wasOpen) logRuntime('plugin.logs', 'closed');
}

function restorePlaceholder() {
  if (previousPlaceholder == null) return;
  if (micaUI.terminalInput.placeholder.get() === LOGS_PLACEHOLDER) {
    micaUI.terminalInput.placeholder.set(previousPlaceholder);
  }
  previousPlaceholder = null;
}

function getLogColor(entry: RuntimeLogEntry) {
  if (entry.level === 'error') return micaUI.theme.colors.error;
  if (entry.level === 'warn') return micaUI.theme.colors.warning;
  if (entry.level === 'debug') return micaUI.theme.colors.dim;
  return undefined;
}
