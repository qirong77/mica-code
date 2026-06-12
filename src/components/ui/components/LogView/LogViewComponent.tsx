import React from 'react';
import { atom } from 'nanostores';
import { Box, Text, ScrollBox } from '@anthropic/ink';
import { useScheduleState } from '../../hooks/index.js';
import { inputBottomDistanceAtom } from '../../../../store/ui-state.js';

export interface LogEntry {
  text: string;
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
}

const logAtom = atom<LogEntry[]>([]);
const RESERVED_LINES = 4;

export function LogView() {
  const bottomDistance = useScheduleState(inputBottomDistanceAtom);
  const lines = useScheduleState(logAtom);
  const viewportHeight = Math.max(2, (bottomDistance as number) - RESERVED_LINES);

  if (lines.length === 0) return null;

  return (
    <ScrollBox height={viewportHeight} stickyScroll flexDirection="column" paddingLeft={1}>
      {lines.map((line, i) => (
        <Text key={i} color={line.color as any} dimColor={line.dimColor} bold={line.bold}>
          {line.text}
        </Text>
      ))}
    </ScrollBox>
  );
}

export function pushLog(entry: LogEntry | string) {
  logAtom.set([
    ...logAtom.get(),
    typeof entry === 'string' ? { text: entry } : entry,
  ]);
}

export function clearLog() {
  logAtom.set([]);
}
