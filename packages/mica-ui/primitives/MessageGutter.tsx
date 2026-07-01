import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { themeColors } from '../theme.js';

export type MessageGutterTone = 'assistant' | 'user' | 'recap' | 'commit' | 'notice' | 'pending' | 'tool' | 'error' | 'muted';

export interface MessageGutterProps {
  tone?: MessageGutterTone;
  marker?: string;
  markerColor?: string;
  children: React.ReactNode;
  marginTop?: number;
  backgroundColor?: string;
}

const TONE_COLOR: Record<MessageGutterTone, string> = {
  assistant: themeColors.messageGutter,
  user: themeColors.messageUser,
  recap: themeColors.messageRecap,
  commit: themeColors.messageCommit,
  notice: themeColors.messageNotice,
  pending: themeColors.messagePending,
  tool: themeColors.toolDefault,
  error: themeColors.statusError,
  muted: themeColors.responseGuide,
};

export function MessageGutter({
  tone = 'muted',
  marker = '│',
  markerColor,
  children,
  marginTop = 0,
  backgroundColor,
}: MessageGutterProps): React.ReactNode {
  return (
    <Box flexDirection="row" marginTop={marginTop} width="100%" minWidth={0} backgroundColor={backgroundColor}>
      <Box width={2} flexShrink={0}>
        <Text color={markerColor ?? TONE_COLOR[tone]}>{marker}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} paddingLeft={1}>
        {children}
      </Box>
    </Box>
  );
}

export function MessageResponse({ children, marker = '⎿' }: { children: React.ReactNode; marker?: string }) {
  return (
    <MessageGutter tone="muted" marker={marker}>
      {children}
    </MessageGutter>
  );
}
