import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { IfComponent } from './IfComponent.js';

export interface DialogProps {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  paddingX?: number;
}

export function Dialog({ title, children, footer, paddingX = 1 }: DialogProps): React.ReactNode {
  return (
    <Box flexDirection="column" width="100%" minWidth={0} paddingX={paddingX}>
      <IfComponent condition={!!title}>
        <Box paddingBottom={1}>
          <Text dimColor>{title}</Text>
        </Box>
      </IfComponent>
      {children}
      {footer}
    </Box>
  );
}
