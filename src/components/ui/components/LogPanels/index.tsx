import React from 'react';
import { Text, ScrollBox } from '@anthropic/ink';
import { useScheduleState } from '../../hooks/useScheduleState.js';
import { thinkingTextAtom } from '../../../../store/ui-state.js';
import { systemLogAtom } from '../../../../store/logAtom.js';

export function ThinkingPanel(): React.ReactNode {
  const text = useScheduleState(thinkingTextAtom);

  if (text.length === 0) return null;

  return (
    <ScrollBox stickyScroll flexDirection="column" flexGrow={1}>
      <Text dimColor>{text}</Text>
    </ScrollBox>
  );
}

export function SystemLogPanel(): React.ReactNode {
  const lines = useScheduleState(systemLogAtom);
  if (lines.length === 0) return null;

  return (
    <ScrollBox stickyScroll flexDirection="column" flexGrow={1}>
      <Text dimColor>{lines.join('\n')}</Text>
    </ScrollBox>
  );
}
