import { Text } from '@anthropic/ink';
import React from 'react';
import { useSchedulState } from '../../hooks/index.js';
import { contextSizeAtom } from '../../../../store/conversation.js';
import { model } from '../../../../store/config.js';

const THRESHOLDS = [0.1, 0.3, 0.5, 0.8] as const;

// 5档颜色：dim -> 青色 -> 黄色 -> 橙色 -> 红色
const COLORS = ['#7b7b7b', '#26C6DA', '#FFD600', '#FF9800', '#F44336'] as const;

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
  const contextSize = useSchedulState(contextSizeAtom);
  const windowSize = useSchedulState(model.contextWindowSize);

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
