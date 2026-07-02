import React, { useMemo } from 'react';
import { Box, Text } from '@anthropic/ink';
import { runtimeEnv } from '@packages/mica-config/runtimeEnv.js';
import type { MicaUiMessageParam, MicaUiTextBlock } from '../types.js';
import { useScheduleState } from '../hooks/useScheduleState.js';
import { themeColors } from '../theme.js';
import { messages, responseText, pendingInputs, pendingQueueMode } from './state.js';
import { Markdown } from './Markdown.js';
import { MessageGutter } from '../primitives/MessageGutter.js';

const MAX_USER_LINES = runtimeEnv.ui.messageCollapseMaxLines;
const MAX_ASSISTANT_CHARS = runtimeEnv.ui.assistantDisplayMaxChars;
const MAX_NOTICE_CHARS = 3_000;

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

function truncateMiddleText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = `\n\n[message display truncated, omitted ${text.length - maxChars} chars]\n\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(budget * 0.65);
  const tail = Math.floor(budget * 0.35);
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

function formatPendingStatus(queueMode: 'after_iteration' | 'after_turn' | null): string {
  if (queueMode === 'after_turn') return 'waiting to send after current turn';
  if (queueMode === 'after_iteration') return 'waiting to send after current iteration';
  return 'waiting to send';
}

interface LogItem {
  id: string | number;
  role: 'user' | 'assistant' | 'notice';
  text: string;
  variant?: MicaUiMessageParam['variant'];
  command?: string;
}

export const Conversation = (): React.ReactNode => {
  const currentMessages = useScheduleState(messages);
  const currentResponseText = useScheduleState(responseText);
  const currentPendingInputs = useScheduleState(pendingInputs);
  const currentQueueMode = useScheduleState(pendingQueueMode);

  const staticItems = useMemo(
    () =>
      currentMessages.flatMap((msg: MicaUiMessageParam, i: number): LogItem[] => {
        const text = getTextContent(msg.displayContent ?? msg.content);
        if (!text) return [];
        if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'notice') {
          return [{ id: i, role: msg.role, text, variant: msg.variant, command: msg.command }];
        }
        return [];
      }),
    [currentMessages],
  );

  return (
    <Box flexDirection="column">
      {staticItems.map((item: LogItem, index) => {
        if (item.role === 'user') {
          return (
            <MessageGutter
              key={item.id}
              tone="user"
              marker={'\u258c'}
              marginTop={1}
              backgroundColor={themeColors.surfaceUser}
            >
              <Text color={themeColors.messageUser} wrap="wrap">
                {truncateLines(item.text, MAX_USER_LINES)}
              </Text>
            </MessageGutter>
          );
        }
        if (item.role === 'notice') {
          const tone =
            item.variant === 'commit'
              ? 'commit'
              : item.variant === 'recap'
                ? 'recap'
                : item.variant === 'compact'
                  ? 'compact'
                  : 'notice';
          const color =
            item.variant === 'commit'
              ? themeColors.messageCommit
              : item.variant === 'recap'
                ? themeColors.messageRecap
                : item.variant === 'compact'
                  ? themeColors.messageCompact
                  : themeColors.messageNotice;
          const backgroundColor =
            item.variant === 'commit'
              ? themeColors.surfaceCommit
              : item.variant === 'recap'
                ? themeColors.surfaceRecap
                : item.variant === 'compact'
                  ? themeColors.surfaceCompact
                  : themeColors.surfaceNotice;
          const title =
            item.command ??
            (item.variant === 'commit'
              ? '/commit'
              : item.variant === 'recap'
                ? '/recap'
                : item.variant === 'compact'
                  ? '/compact'
                  : 'notice');

          return (
            <React.Fragment key={item.id}>
              <MessageGutter
                tone={tone}
                marker={'\u258c'}
                marginTop={index === 0 ? 0 : 1}
                backgroundColor={backgroundColor}
              >
                <Text color={color}>{title}</Text>
              </MessageGutter>
              <MessageGutter tone="muted" marker="" marginTop={1}>
                <Markdown>{truncateMiddleText(item.text, MAX_NOTICE_CHARS)}</Markdown>
              </MessageGutter>
            </React.Fragment>
          );
        }
        return (
          <MessageGutter key={item.id} tone="assistant" marker="●" marginTop={index === 0 ? 0 : 1}>
            <Markdown>{truncateMiddleText(item.text, MAX_ASSISTANT_CHARS)}</Markdown>
          </MessageGutter>
        );
      })}
      {currentResponseText ? (
        <MessageGutter tone="assistant" marker="●" marginTop={staticItems.length > 0 ? 1 : 0}>
          <Markdown>{truncateMiddleText(currentResponseText, MAX_ASSISTANT_CHARS)}</Markdown>
        </MessageGutter>
      ) : null}
      {currentPendingInputs.map((text, i) => (
        <MessageGutter key={`pending-${i}`} tone="pending" marker={'\u258c'} marginTop={1}>
          <Text color={themeColors.messagePending} italic>
            {truncateLines(text, MAX_USER_LINES)}
          </Text>
          <Text color={themeColors.messagePending}>
            {'  '}({formatPendingStatus(currentQueueMode)} · shift + ⬅️ to re-edit)
          </Text>
        </MessageGutter>
      ))}
    </Box>
  );
};

export const ConversationUI = { renderFn: Conversation };
