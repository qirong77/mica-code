import React from 'react';
import { atom } from 'nanostores';
import { Box, Text, ScrollBox, useTerminalSize } from '@anthropic/ink';
import { useScheduleState } from '../hooks/index.js';
import { inputBottomDistanceAtom } from '../../store/uiState.js';

export interface LogEntry {
  text: string;
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
}

const logAtom = atom<LogEntry[]>([]);
const RESERVED_LINES = 2;

export function LogView() {
  const bottomDistance = useScheduleState(inputBottomDistanceAtom);
  const lines = useScheduleState(logAtom);
  const { columns, rows } = useTerminalSize();
  const viewportHeight = Math.max(
    5,
    (bottomDistance as number) - RESERVED_LINES,
    Math.ceil(rows / 2),
  );

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
