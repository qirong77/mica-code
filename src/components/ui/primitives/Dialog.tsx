import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { IfComponent } from '../components/common/IfComponent';

export interface DialogProps {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export function Dialog({ title, children, footer }: DialogProps): React.ReactNode {
  return (
    <Box flexDirection="column" paddingX={1}>
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
