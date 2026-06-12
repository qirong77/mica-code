import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { C } from '../data.js';

const ICONS: Record<string, string> = {
  success: '\u2713',
  error: '\u2717',
  warning: '\u26A0',
  info: '\u2139',
};

const COLORS = {
  success: C.success,
  error: C.error,
  warning: C.warning,
  info: C.info,
} as const;

export interface StatusRowProps {
  type: 'success' | 'error' | 'warning' | 'info';
  children: React.ReactNode;
}

export function StatusRow({ type, children }: StatusRowProps): React.ReactNode {
  const icon = ICONS[type] ?? '';
  const color = COLORS[type] ?? C.dim;

  return (
    <Box>
      <Text color={color}>
        {icon} {children}
      </Text>
    </Box>
  );
}
