import React, { useMemo } from 'react';
import { Box, Text } from '@anthropic/ink';
import type Anthropic from '@anthropic-ai/sdk';
import { C } from '../../data.js';
import { messagesAtom } from '../../../../store/conversation.js';
import { responseTextAtom } from '../../../../store/ui-state.js';
import { useSchedulState } from '../../hooks/useSchedulState.js';
import { Markdown } from './Markdown.js';

interface LogMessage extends Anthropic.MessageParam {
  status?: 'clear';
}

function getTextContent(content: Anthropic.MessageParam['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

interface LogItem {
  id: string | number;
  role: 'user' | 'assistant';
  text: string;
}

export const Conversation = (): React.ReactNode => {
  const messages = useSchedulState(messagesAtom);
  const responseText = useSchedulState(responseTextAtom);

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
            <Box key={item.id} paddingX={1} paddingY={1} flexDirection="row">
              <Text color={C.primary}>{'\u258c'}</Text>
              <Box flexGrow={1} paddingLeft={1} paddingRight={1}>
                <Text bold color={C.primary}>
                  {item.text}
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
      {responseText && (
        <Box>
          <Markdown>{responseText}</Markdown>
        </Box>
      )}
    </Box>
  );
};
