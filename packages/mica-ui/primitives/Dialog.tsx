import React from 'react';
import { Box, Text } from '@anthropic/ink';

export interface DialogProps {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  paddingX?: number;
}

export function Dialog({ title, children, footer, paddingX = 1 }: DialogProps): React.ReactNode {
  return (
    <Box flexDirection="column" width="100%" minWidth={0} paddingX={paddingX}>
      {title ? (
        <Box paddingBottom={1}>
          <Text dimColor>{title}</Text>
        </Box>
      ) : null}
      {children}
      {footer}
    </Box>
  );
}
