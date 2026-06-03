import React from 'react';
import { Text, ScrollBox, useTerminalSize } from '@anthropic/ink';
import { useScheduleState } from '../../hooks/useScheduleState.js';
import { thinkingTextAtom } from '../../../../store/ui-state.js';
import { systemLogAtom } from '../../../../store/logAtom.js';

const MIN_LINES = 5;

export function ThinkingPanel(): React.ReactNode {
  const text = useScheduleState(thinkingTextAtom);
  const { rows } = useTerminalSize();
  const maxLines = Math.max(Math.floor(rows / 2), MIN_LINES);
  return (
    <ScrollBox stickyScroll flexDirection="column" height={maxLines}>
      <Text dimColor>{text}</Text>
    </ScrollBox>
  );
}

export function SystemLogPanel(): React.ReactNode {
  const lines = useScheduleState(systemLogAtom);
  const { rows } = useTerminalSize();
  const maxLines = Math.max(Math.floor(rows / 2), MIN_LINES);
  return (
    <ScrollBox stickyScroll flexDirection="column" height={maxLines}>
      <Text dimColor>{lines.join('\n')}</Text>
    </ScrollBox>
  );
}
