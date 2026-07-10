import React, { useEffect, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import type { MicaUiCommandPanelItem, MicaUiCommandPanelVariant } from '../types.js';
import { useScheduleState } from '../hooks/index.js';
import { MessageGutter } from '../primitives/MessageGutter.js';
import { Spin } from '../primitives/Spin.js';
import { themeColors } from '../theme.js';
import { formatElapsed } from '../utils/format.js';
import { commandPanelItems } from './state.js';

const MAX_PANEL_TEXT_CHARS = 1_000;

type CommandPanelPresentation = {
  color: string;
  backgroundColor: string;
};

const PRESENTATION_BY_VARIANT: Record<MicaUiCommandPanelVariant, CommandPanelPresentation> = {
  commit: {
    color: themeColors.messageCommit,
    backgroundColor: themeColors.surfaceCommit,
  },
  config: {
    color: themeColors.messageConfig,
    backgroundColor: themeColors.surfaceConfig,
  },
  compact: {
    color: themeColors.messageCompact,
    backgroundColor: themeColors.surfaceCompact,
  },
  error: {
    color: themeColors.messageError,
    backgroundColor: themeColors.surfaceError,
  },
};

const DEFAULT_PRESENTATION: CommandPanelPresentation = {
  color: themeColors.messageNotice,
  backgroundColor: themeColors.surfaceNotice,
};

const RUNNING_STATUS_TEXT = 'running';

export function CommandPanel(): React.ReactNode {
  const items = useScheduleState(commandPanelItems);
  const runningItems = items.filter((item) => item.status === 'running');
  const hasRunningItem = runningItems.length > 0;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!hasRunningItem) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunningItem]);

  if (runningItems.length === 0) return null;

  return (
    <Box paddingX={1} marginTop={1} flexDirection="column" width="100%" minWidth={0}>
      {runningItems.map((item, index) => (
        <CommandPanelRow key={item.id} item={item} nowMs={nowMs} marginTop={index === 0 ? 0 : 1} />
      ))}
    </Box>
  );
}

function CommandPanelRow({
  item,
  nowMs,
  marginTop,
}: {
  item: MicaUiCommandPanelItem;
  nowMs: number;
  marginTop: number;
}): React.ReactNode {
  const presentation = presentationFor(item);
  const elapsedText =
    item.status === 'running' && item.startedAt ? formatElapsed(Math.max(0, nowMs - item.startedAt)) : null;
  const progressLines = visibleProgressLines(item);

  return (
    <MessageGutter
      tone="user"
      marker={'\u258c'}
      markerColor={themeColors.messageGutter}
      marginTop={marginTop}
      backgroundColor={presentation.backgroundColor}
    >
      <Box flexDirection="column" width="100%" minWidth={0}>
        <Box flexDirection="row" width="100%" minWidth={0}>
          {item.status === 'running' ? <Spin /> : null}
          <Text color={presentation.color} wrap="wrap">
            {`${item.command} ${RUNNING_STATUS_TEXT}`}
          </Text>
          {elapsedText ? (
            <Box marginLeft={1} flexShrink={0}>
              <Text color={themeColors.inactive}>{elapsedText}</Text>
            </Box>
          ) : null}
        </Box>
        {progressLines.map((line, index) => (
          <Text key={`${item.id}-progress-${index}`} color={themeColors.inactive} wrap="wrap">
            {truncateMiddleText(line, MAX_PANEL_TEXT_CHARS)}
          </Text>
        ))}
      </Box>
    </MessageGutter>
  );
}

function presentationFor(item: MicaUiCommandPanelItem): CommandPanelPresentation {
  if (item.status === 'error') return PRESENTATION_BY_VARIANT.error;
  return item.variant ? PRESENTATION_BY_VARIANT[item.variant] : DEFAULT_PRESENTATION;
}

function visibleProgressLines(item: MicaUiCommandPanelItem): string[] {
  const lines = item.lines ?? [];
  if (item.status !== 'running') return [];
  const recent = lines.filter((line) => line !== item.text).slice(-2);
  return [...recent, item.text].slice(-3);
}

function truncateMiddleText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = `\n\n[command output truncated, omitted ${text.length - maxChars} chars]\n\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(budget * 0.65);
  const tail = Math.floor(budget * 0.35);
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

export const CommandPanelUI = { renderFn: CommandPanel };
