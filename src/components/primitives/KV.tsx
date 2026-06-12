import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { C } from '../data.js';

export interface KVProps {
  label: string;
  children?: React.ReactNode;
}

export function KV({ label, children }: KVProps): React.ReactNode {
  return (
    <Box>
      <Text color={C.textSecondary}>{label}: </Text>
      <Text>{children}</Text>
    </Box>
  );
}
