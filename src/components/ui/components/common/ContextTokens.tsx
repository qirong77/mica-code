import { Text } from '@anthropic/ink';
import React from 'react';
import { useScheduleState } from '../../hooks/index.js';
import { contextSizeAtom } from '../../../../store/conversation.js';
import { model } from '../../../../store/config.js';
import { C } from '../../data.js';

const THRESHOLDS = [0.1, 0.3, 0.5, 0.8] as const;

const COLORS = [C.dim, C.info, C.warning, '#FF9800', C.error] as const;

function getColorIndex(ratio: number): number {
  for (let i = THRESHOLDS.length - 1; i >= 0; i--) {
    if (ratio >= THRESHOLDS[i]) return i + 1;
  }
  return 0;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

export function ContextTokens() {
  const contextSize = useScheduleState(contextSizeAtom);
  const windowSize = useScheduleState(model.contextWindowSize);

  if (contextSize <= 0 || windowSize <= 0) return null;

  const ratio = contextSize / windowSize;
  const colorIndex = getColorIndex(ratio);
  const color = COLORS[colorIndex];
  const tokenStr = formatTokens(contextSize);

  const showPercent = ratio >= 0.3;
  const percentStr = showPercent ? ` (${(ratio * 100).toFixed(0)}%)` : '';

  return (
    <Text color={color}>
      {' · '}{tokenStr} tokens{percentStr}
    </Text>
  );
}
