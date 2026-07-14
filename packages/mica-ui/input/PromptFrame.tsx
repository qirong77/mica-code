import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { themeColors } from '../theme.js';

export type PromptFrameMode = 'default' | 'command' | 'queue' | 'plugin' | 'disabled';

type BorderTextOptions = {
  content: string;
  position: 'top' | 'bottom';
  align: 'start' | 'end' | 'center';
  offset?: number;
};

export interface PromptFrameProps {
  mode: PromptFrameMode;
  label?: string;
  role?: string;
  children: React.ReactNode;
}

const PROMPT_FRAME_VISUAL: Record<PromptFrameMode, { borderColor: string; markerColor: string; marker: string }> = {
  default: {
    borderColor: themeColors.promptBorder,
    markerColor: themeColors.text,
    marker: '❯',
  },
  command: {
    borderColor: themeColors.promptBorder,
    markerColor: themeColors.text,
    marker: '❯',
  },
  queue: {
    borderColor: themeColors.promptBorderQueue,
    markerColor: themeColors.promptBorderQueue,
    marker: '↳',
  },
  plugin: {
    borderColor: themeColors.promptBorderPlugin,
    markerColor: themeColors.promptBorderPlugin,
    marker: '◆',
  },
  disabled: {
    borderColor: themeColors.promptBorderDisabled,
    markerColor: themeColors.inactive,
    marker: '·',
  },
};

export function PromptFrame({ mode, label, role, children }: PromptFrameProps): React.ReactNode {
  const visual = PROMPT_FRAME_VISUAL[mode];
  const roleLabel = role && role !== 'default' ? role : undefined;
  const borderText: BorderTextOptions | undefined = label
    ? {
        content: ` ${label} `,
        position: 'top',
        align: 'end',
        offset: 1,
      }
    : undefined;

  return (
    <Box
      flexDirection="row"
      alignItems="flex-start"
      justifyContent="flex-start"
      borderColor={visual.borderColor}
      borderStyle="round"
      borderLeft={false}
      borderRight={false}
      borderBottom
      width="100%"
      borderText={borderText}
    >
      <Box marginLeft={1} marginRight={1} flexShrink={0}>
        {roleLabel ? <Text color={visual.markerColor}>{roleLabel} </Text> : null}
        <Text color={visual.markerColor} bold={mode !== 'disabled'}>
          {visual.marker}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}
