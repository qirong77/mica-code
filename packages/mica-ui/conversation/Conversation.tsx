import React, { useMemo } from 'react';
import { Box, Text } from '@anthropic/ink';
import type { MicaUiMessageParam, MicaUiTextBlock } from '../types.js';
import { useScheduleState } from '../hooks/useScheduleState.js';
import { themeColors } from '../theme.js';
import { messages, responseText } from './state.js';
import { Markdown } from './Markdown.js';

const MAX_USER_LINES = 10;

function getTextContent(content: MicaUiMessageParam['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is MicaUiTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + '…';
}

interface LogItem {
  id: string | number;
  role: 'user' | 'assistant';
  text: string;
}

export const Conversation = (): React.ReactNode => {
  const currentMessages = useScheduleState(messages);
  const currentResponseText = useScheduleState(responseText);

  const staticItems = useMemo(
    () =>
      currentMessages.flatMap((msg: MicaUiMessageParam, i: number): LogItem[] => {
        const text = getTextContent(msg.content);
        if (!text) return [];
        if (msg.role === 'user' || msg.role === 'assistant') {
          return [{ id: i, role: msg.role, text }];
        }
        return [];
      }),
    [currentMessages],
  );

  return (
    <Box flexDirection="column">
      {staticItems.map((item: LogItem, index) => {
        const isLast = index === staticItems.length - 1 && !currentResponseText;
        if (item.role === 'user') {
          return (
            <Box key={item.id} paddingY={1} paddingBottom={isLast ? 0 : 1} flexDirection="row">
              <Text color={themeColors.primary}>{'\u258c'}</Text>
              <Box flexGrow={1} paddingLeft={1} paddingRight={1}>
                <Text color={themeColors.primary} bold>
                  {truncateLines(item.text, MAX_USER_LINES)}
                </Text>
              </Box>
            </Box>
          );
        }
        return (
          <Box key={item.id}>
            <Markdown>{item.text}</Markdown>
          </Box>
        );
      })}
      <Box>
        <Markdown>{currentResponseText}</Markdown>
      </Box>
    </Box>
  );
};

export const ConversationUI = { renderFn: Conversation };
