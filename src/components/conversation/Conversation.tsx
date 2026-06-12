import React, { useMemo } from 'react';
import { Box, Text } from '@anthropic/ink';
import type Anthropic from '@anthropic-ai/sdk';
import { C } from '../data.js';
import { messagesAtom } from '../../store/conversation.js';
import { responseTextAtom, pendingInputAtom } from '../../store/ui-state.js';
import { useScheduleState } from '../hooks/useScheduleState.js';
import { Markdown } from './Markdown.js';

interface LogMessage extends Anthropic.MessageParam {
  status?: 'clear';
}

const MAX_USER_LINES = 10;

function getTextContent(content: Anthropic.MessageParam['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
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
  const messages = useScheduleState(messagesAtom);
  const responseText = useScheduleState(responseTextAtom);
  const pendingInput = useScheduleState(pendingInputAtom);

  const staticItems = useMemo(
    () =>
      messages.flatMap((raw, i): LogItem[] => {
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
              <Text color={C.primary}>{'\u258c'}</Text>
              <Box flexGrow={1} paddingLeft={1} paddingRight={1}>
                <Text bold color={C.primary}>
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
      {pendingInput && (
        <Box paddingY={1} flexDirection="row">
          <Text color={C.dim}>{'\u258c'}</Text>
          <Box flexGrow={1} paddingLeft={1} paddingRight={1}>
            <Text color={C.dim}>{truncateLines(pendingInput, MAX_USER_LINES)}{'（等待当前 agent 执行完成后发送）'}</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};

export const ConversationUI = { renderFn: Conversation };
