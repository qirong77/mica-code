import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { C } from '../data.js';

export interface PanelProps {
  header?: string;
  children?: React.ReactNode;
}

export function Panel({ header, children }: PanelProps): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Box
        borderBottom
        borderStyle="single"
        borderColor={C.border}
        paddingLeft={1}
      >
        {header ? (
          <Text color={C.accent}>{header}</Text>
        ) : null}
      </Box>
      <Box paddingX={1} flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}
