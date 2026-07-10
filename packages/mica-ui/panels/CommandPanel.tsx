import React, { useEffect, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import type { MicaUiCommandPanelItem, MicaUiCommandPanelStatus, MicaUiCommandPanelVariant } from '../types.js';
import { Markdown } from '../conversation/Markdown.js';
import { useScheduleState } from '../hooks/index.js';
import { MessageGutter, type MessageGutterTone } from '../primitives/MessageGutter.js';
import { Spin } from '../primitives/Spin.js';
import { themeColors } from '../theme.js';
import { formatElapsed } from '../utils/format.js';
import { commandPanelItems } from './state.js';

const MAX_PANEL_TEXT_CHARS = 2_400;

type CommandPanelPresentation = {
  tone: MessageGutterTone;
  color: string;
  backgroundColor: string;
};

const PRESENTATION_BY_VARIANT: Record<MicaUiCommandPanelVariant, CommandPanelPresentation> = {
  commit: {
    tone: 'commit',
    color: themeColors.messageCommit,
    backgroundColor: themeColors.surfaceCommit,
  },
  config: {
    tone: 'config',
    color: themeColors.messageConfig,
    backgroundColor: themeColors.surfaceConfig,
  },
  compact: {
    tone: 'compact',
    color: themeColors.messageCompact,
    backgroundColor: themeColors.surfaceCompact,
  },
  error: {
    tone: 'error',
    color: themeColors.messageError,
    backgroundColor: themeColors.surfaceError,
  },
};

const DEFAULT_PRESENTATION: CommandPanelPresentation = {
  tone: 'notice',
  color: themeColors.messageNotice,
  backgroundColor: themeColors.surfaceNotice,
};

export function CommandPanel(): React.ReactNode {
  const items = useScheduleState(commandPanelItems);
  const hasRunningItem = items.some((item) => item.status === 'running');
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!hasRunningItem) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunningItem]);

  if (items.length === 0) return null;

  return (
    <Box paddingX={1} marginTop={1} flexDirection="column" width="100%" minWidth={0}>
      {items.map((item, index) => (
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
    item.status === 'running' && item.startedAt ? ` ${formatElapsed(Math.max(0, nowMs - item.startedAt))}` : '';
  const detailLines = item.status === 'running' ? visibleProgressLines(item) : [];

  return (
    <Box flexDirection="column" width="100%" minWidth={0} marginTop={marginTop}>
      <MessageGutter
        tone={presentation.tone}
        marker="|"
        backgroundColor={presentation.backgroundColor}
      >
        <Box paddingX={1} paddingY={0} width="100%" minWidth={0}>
          <Box flexDirection="row" minWidth={0}>
            {item.status === 'running' ? <Spin /> : null}
            <Text color={presentation.color}>{item.command}</Text>
            <Text color={themeColors.inactive}> {statusLabel(item.status)}</Text>
            {elapsedText ? <Text color={themeColors.inactive}>{elapsedText}</Text> : null}
          </Box>
        </Box>
      </MessageGutter>
      <MessageGutter tone="muted" marker="" backgroundColor={presentation.backgroundColor}>
        <Box paddingLeft={2} paddingRight={1} paddingBottom={1} width="100%" minWidth={0} flexDirection="column">
          <Markdown>{truncateMiddleText(item.text, MAX_PANEL_TEXT_CHARS)}</Markdown>
          {detailLines.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              {detailLines.map((line, index) => (
                <Text key={`${item.id}-line-${index}`} color={themeColors.inactive} wrap="wrap">
                  {line}
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
      </MessageGutter>
    </Box>
  );
}

function presentationFor(item: MicaUiCommandPanelItem): CommandPanelPresentation {
  if (item.status === 'error') return PRESENTATION_BY_VARIANT.error;
  return item.variant ? PRESENTATION_BY_VARIANT[item.variant] : DEFAULT_PRESENTATION;
}

function statusLabel(status: MicaUiCommandPanelStatus): string {
  switch (status) {
    case 'running':
      return 'running';
    case 'success':
      return 'done';
    case 'warning':
      return 'warning';
    case 'error':
      return 'failed';
    case 'info':
      return 'info';
  }
}

function visibleProgressLines(item: MicaUiCommandPanelItem): string[] {
  const lines = item.lines ?? [];
  if (lines.length <= 1) return [];
  return lines.filter((line) => line !== item.text).slice(-3);
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
