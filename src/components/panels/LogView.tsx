import React from 'react';
import { atom } from 'nanostores';
import { Box, Text, ScrollBox, useTerminalSize } from '@anthropic/ink';
import { useScheduleState } from '../hooks/index.js';
import { useLogViewHeight } from '../hooks/useLogViewHeight.js';

export interface LogEntry {
  text: string;
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
}

const logAtom = atom<LogEntry[]>([]);

export function LogView() {
  const lines = useScheduleState(logAtom);
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

export function pushLog(entry: LogEntry | string) {
  logAtom.set([...logAtom.get(), typeof entry === 'string' ? { text: entry } : entry]);
}

export function clearLog() {
  logAtom.set([]);
}
