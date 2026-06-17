import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import type { MicaUiMessageParam, MicaUiTextBlock } from '../types.js';
import { micaUI } from '../index.js';
import { useScheduleState } from '../hooks/useScheduleState.js';
import { Markdown } from './Markdown.js';

function useDots(delay = 500): string {
  const [dots, setDots] = useState('');
  useEffect(() => {
    const timer = setInterval(() => {
      setDots((d) => (d.length >= 3 ? '' : d + '.'));
    }, delay);
    return () => clearInterval(timer);
  }, [delay]);
  return dots;
}

interface LogMessage extends MicaUiMessageParam {
  status?: 'clear';
}

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
  const { colors } = micaUI.theme;
  const messages = useScheduleState(micaUI.conversation.messages);
  const responseText = useScheduleState(micaUI.conversation.responseText);
  const pendingInputs = useScheduleState(micaUI.conversation.pendingInputs);
  const dots = useDots();

  const staticItems = useMemo(
    () =>
      (messages as any[]).flatMap((raw: any, i: number): LogItem[] => {
        const msg = raw as LogMessage;
        if (msg.status === 'clear') return [];
        const text = getTextContent(msg.content);
        if (!text) return [];
        if (msg.role === 'user' || msg.role === 'assistant') {
          return [{ id: i, role: msg.role, text }];
        }
        return [];
      }),
    [messages],
  );

  return (
    <Box flexDirection="column">
      {staticItems.map((item: LogItem) => {
        if (item.role === 'user') {
          return (
            <Box key={item.id} paddingY={1} flexDirection="row">
              <Text color={colors.primary}>{'\u258c'}</Text>
              <Box flexGrow={1} paddingLeft={1} paddingRight={1}>
                <Text bold color={colors.primary}>
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
        <Markdown>{responseText}</Markdown>
      </Box>
      {pendingInputs.map((pendingInput, index) => (
        <Box key={`pending-${index}`} paddingY={1} flexDirection="row">
          <Text color={colors.dim}>{'\u258c'}</Text>
          <Box flexGrow={1} paddingLeft={1} paddingRight={1} flexDirection="row">
            <Text color={colors.dim}>{truncateLines(pendingInput, MAX_USER_LINES)}</Text>
            <Text color={colors.dim}>
              {'（等待当前 agent 执行完成后发送'}
              {dots}
              {'）'}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
};

export const ConversationUI = { renderFn: Conversation };
