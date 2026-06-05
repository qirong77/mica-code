import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { KeyHints } from './KeyHints.js';

export interface DetailViewProps {
  header: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export function DetailView({ header, children, footer }: DetailViewProps): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Box paddingBottom={1}>
        {typeof header === 'string' ? <Text bold>{header}</Text> : header}
      </Box>
      {children}
      {footer ?? <KeyHints hints={['esc back']} />}
    </Box>
  );
}
