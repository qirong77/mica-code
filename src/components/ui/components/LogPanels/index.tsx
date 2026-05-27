import React from 'react';
import { Text, ScrollBox, useTerminalSize } from '@anthropic/ink';
import { useScheduleState } from '../../hooks/useScheduleState.js';
import { thinkingTextAtom } from '../../../../store/ui-state.js';
import { systemLogAtom } from '../../../../store/logAtom.js';

const MIN_LINES = 5;

function useLogHeight(): number {
  const { rows } = useTerminalSize();
  return Math.max(Math.floor(rows / 2), MIN_LINES);
}

export function ThinkingPanel(): React.ReactNode {
  const text = useScheduleState(thinkingTextAtom);
  const maxLines = useLogHeight();

  if (text.length === 0) return null;

  return (
    <ScrollBox stickyScroll flexDirection="column" height={maxLines}>
      <Text dimColor>{text}</Text>
    </ScrollBox>
  );
}

export function SystemLogPanel(): React.ReactNode {
  const lines = useScheduleState(systemLogAtom);
  const maxLines = useLogHeight();
  if (lines.length === 0) return null;

  return (
    <ScrollBox stickyScroll flexDirection="column" height={maxLines}>
      <Text dimColor>{lines.join('\n')}</Text>
    </ScrollBox>
  );
}
