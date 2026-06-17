import React from 'react';
import { Box, Text, ScrollBox } from '@anthropic/ink';
import { useScheduleState } from '../hooks/index.js';
import { useLogViewHeight } from '../hooks/useLogViewHeight.js';
import { uiLog } from './state.js';

export function LogView() {
  const lines = useScheduleState(uiLog);
  const viewportHeight = useLogViewHeight();
  return (
    <ScrollBox height={viewportHeight} stickyScroll flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} color={line.color as any} dimColor={true} bold={line.bold}>
          {line.text}
        </Text>
      ))}
    </ScrollBox>
  );
}
