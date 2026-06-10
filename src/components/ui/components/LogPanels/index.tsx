import React from 'react';
import { Text, ScrollBox, useTerminalSize } from '@anthropic/ink';
import { useScheduleState } from '../../hooks/useScheduleState.js';
import { thinkingTextAtom, inputBottomDistanceAtom } from '../../../../store/ui-state.js';
import { systemLogAtom } from '../../../../store/logAtom.js';

const MIN_LINES = 3;

export function ThinkingPanel(): React.ReactNode {
  const text = useScheduleState(thinkingTextAtom);
  const bottomDistance = useScheduleState(inputBottomDistanceAtom);
  const { rows } = useTerminalSize();
  const fromBottom = bottomDistance > 0 ? bottomDistance - 2 : Math.floor(rows / 2);
  const maxLines = Math.max(Math.min(fromBottom, Math.floor(rows / 2)), MIN_LINES);
  return (
    <ScrollBox stickyScroll flexDirection="column" height={maxLines}>
      <Text dimColor>{text}</Text>
    </ScrollBox>
  );
}

export function SystemLogPanel(): React.ReactNode {
  const lines = useScheduleState(systemLogAtom);
  const bottomDistance = useScheduleState(inputBottomDistanceAtom);
  const { rows } = useTerminalSize();
  const fromBottom = bottomDistance > 0 ? bottomDistance - 2 : Math.floor(rows / 2);
  const maxLines = Math.max(Math.min(fromBottom, Math.floor(rows / 2)), MIN_LINES);
  return (
    <ScrollBox stickyScroll flexDirection="column" height={maxLines}>
      <Text dimColor>{lines.join('\n')}</Text>
    </ScrollBox>
  );
}
