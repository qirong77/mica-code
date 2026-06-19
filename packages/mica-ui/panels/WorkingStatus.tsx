import { Box, Text } from '@anthropic/ink';
import { useEffect, useRef, useState } from 'react';
import { useScheduleState } from '../hooks/index.js';
import { workingStatus, thinkingText, modelDisplay, contextSize, cachedTokenRate } from './state.js';
import { responseText as convResponseText } from '../conversation/state.js';
import { themeColors } from '../theme.js';
import { Spin } from '../primitives/Spin.js';
import { IfComponent } from '../primitives/IfComponent.js';
import { formatElapsed } from '../utils/format.js';
import { getWorkingStatusDisplay } from '../utils/workingStatusDisplay.js';

const CTX_THRESHOLDS = [0.3, 0.45, 0.6, 0.8] as const;
const CONTEXT_USAGE_COLORS = [
  themeColors.dim,
  themeColors.info,
  themeColors.warning,
  '#FF9800',
  themeColors.error,
] as const;

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function getContextUsageColorIndex(ratio: number): number {
  for (let i = CTX_THRESHOLDS.length - 1; i >= 0; i--) {
    if (ratio >= CTX_THRESHOLDS[i]) return i + 1;
  }
  return 0;
}

function StatusInfo() {
  const modelValue = useScheduleState(modelDisplay.name);
  const effortLevel = useScheduleState(modelDisplay.effort);
  const contextTokens = useScheduleState(contextSize);
  const windowSize = useScheduleState(modelDisplay.contextWindowSize);
  const cachedRate = useScheduleState(cachedTokenRate);
  const tokenStr = formatTokens(contextTokens);
  const cachedPct = (cachedRate * 100).toFixed(0);
  const modelText = `${modelValue}_${effortLevel}`;
  if (contextTokens <= 0 || windowSize <= 0)
    return (
      <Text color={themeColors.dim} wrap="wrap">
        {modelText}
      </Text>
    );
  return (
    <Text wrap="wrap">
      <Text color={themeColors.dim}>{modelText}</Text>{' '}
      <Text color={CONTEXT_USAGE_COLORS[getContextUsageColorIndex(contextTokens / windowSize)]}>
        {tokenStr} ({cachedPct}% cached tokens)
      </Text>
    </Text>
  );
}

function estimateTokens(text: string): number {
  let ascii = 0,
    cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x20000 && code <= 0x2ceaf) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    )
      cjk++;
    else ascii++;
  }
  return Math.max(1, Math.ceil(ascii / 4 + cjk / 1.5));
}

export function WorkingStatus() {
  const info = useScheduleState(workingStatus);
  const currentThinkingText = useScheduleState(thinkingText);
  const currentResponseText = useScheduleState(convResponseText);
  const startRef = useRef(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (info.type === 'idle' || info.type === 'completed' || info.type === 'error') {
      startRef.current = 0;
      setElapsed(0);
      return;
    }
    if (!startRef.current) startRef.current = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - startRef.current), 100);
    return () => clearInterval(timer);
  }, [info.type]);

  const displayElapsed =
    info.type === 'completed' || info.type === 'calling_tool' ? (info.elapsedMs ?? elapsed) : elapsed;
  const elapsedText = displayElapsed > 0 ? formatElapsed(displayElapsed) : '';
  const statusDisplay = getWorkingStatusDisplay(info);

  const content = (() => {
    switch (info.type) {
      case 'connecting':
        return (
          <Box>
            <Spin />
            <Text color={statusDisplay.color}>{statusDisplay.text}</Text>
          </Box>
        );
      case 'thinking':
        return (
          <Box>
            <Spin />
            <Text color={statusDisplay.color}>{statusDisplay.text}</Text>
            <Text color={themeColors.dim}> ↓{estimateTokens(currentThinkingText)} tokens</Text>
          </Box>
        );
      case 'streaming':
        return (
          <Box>
            <Spin />
            <Text color={statusDisplay.color}>{statusDisplay.text}</Text>
            <Text color={themeColors.dim}> ↓{estimateTokens(currentResponseText)} tokens</Text>
          </Box>
        );
      case 'calling_tool':
        return (
          <Box>
            <Spin />
            <Text color={statusDisplay.color}>{statusDisplay.text}</Text>
          </Box>
        );
      case 'plugin_task':
        return (
          <Box>
            <Spin />
            <Text color={statusDisplay.color}>{statusDisplay.text}</Text>
          </Box>
        );
      case 'error':
        return <Text color={statusDisplay.color}>{statusDisplay.text}</Text>;
      case 'completed':
        return <Text color={statusDisplay.color}>{statusDisplay.text}</Text>;
      default:
        return null;
    }
  })();

  return (
    <Box flexDirection="row">
      <Box flexGrow={1} flexShrink={1}>
        {content}
      </Box>
      <Box flexShrink={0} paddingRight={4} flexDirection="row">
        <StatusInfo />
        <IfComponent condition={info.type !== 'completed' && info.type !== 'error' && info.type !== 'idle'}>
          <Text color={themeColors.dim}> {elapsedText}</Text>
        </IfComponent>
      </Box>
    </Box>
  );
}

export const WorkingStatusUI = { renderFn: WorkingStatus };
