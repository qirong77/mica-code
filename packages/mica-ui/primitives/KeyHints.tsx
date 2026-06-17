import React from 'react';
import { Box, Text } from '@anthropic/ink';

export interface KeyHintsProps {
  hints: string[];
}

export function KeyHints({ hints }: KeyHintsProps): React.ReactNode {
  return (
    <Box paddingTop={1}>
      <Text dimColor>{hints.join('  ')}</Text>
    </Box>
  );
}
