import { Box, Text } from '@anthropic/ink';
import { useEffect, useRef, useState } from 'react';
import { formatTokenCount } from '@packages/mica-common/format.js';
import { runtimeEnv } from '@packages/mica-config/runtimeEnv.js';
import { useScheduleState } from '../hooks/index.js';
import { workingStatus, thinkingText, modelDisplay, contextSize, cachedTokenRate } from './state.js';
import { responseText as convResponseText } from '../conversation/state.js';
import { queueStatusText } from '../input/state.js';
import { themeColors } from '../theme.js';
import { Spin } from '../primitives/Spin.js';
import { formatElapsed } from '../utils/format.js';
import { getWorkingStatusDisplay, getWorkingStatusTotalElapsed } from '../utils/workingStatusDisplay.js';
import type { MicaUiWorkingStatus } from '../types.js';

const CTX_RATIO_THRESHOLDS = [0.3, 0.45, 0.6, 0.8] as const;
const CTX_TOKEN_THRESHOLDS = [80_000, 112_000, 160_000, 208_000] as const;
const CONTEXT_USAGE_COLORS = [
  themeColors.inactive,
  themeColors.statusInfo,
  themeColors.statusWarning,
  '#FF9800',
  themeColors.statusError,
] as const;

function getThresholdLevel(value: number, thresholds: readonly number[]): number {
  for (let i = thresholds.length - 1; i >= 0; i--) {
    if (value >= thresholds[i]) return i + 1;
  }
  return 0;
}

export function getContextUsageColorIndex(contextTokens: number, windowSize: number): number {
  const ratio = windowSize > 0 ? contextTokens / windowSize : 0;
  const ratioLevel = getThresholdLevel(ratio, CTX_RATIO_THRESHOLDS);
  const tokenLevel = getThresholdLevel(contextTokens, CTX_TOKEN_THRESHOLDS);
  return Math.max(ratioLevel, tokenLevel);
}

function StatusInfo() {
  const modelValue = useScheduleState(modelDisplay.name);
  const effortLevel = useScheduleState(modelDisplay.effort);
  const contextTokens = useScheduleState(contextSize);
  const windowSize = useScheduleState(modelDisplay.contextWindowSize);
  const cachedRate = useScheduleState(cachedTokenRate);
  const tokenStr = formatTokenCount(contextTokens);
  const cachedPct = (cachedRate * 100).toFixed(0);
  const contextRatio = contextTokens / windowSize;
  const contextPct = (contextRatio * 100).toFixed(0);
  const modelText = `${modelValue}_${effortLevel}`;
  if (contextTokens <= 0 || windowSize <= 0)
    return (
      <Text color={themeColors.inactive} wrap="wrap">
        {modelText}
      </Text>
    );
  return (
    <Text wrap="wrap">
      <Text color={themeColors.inactive}>{modelText}</Text>{' '}
      <Text color={themeColors.inactive}>
        {tokenStr} (cached {cachedPct}%,{' '}
      </Text>
      <Text color={CONTEXT_USAGE_COLORS[getContextUsageColorIndex(contextTokens, windowSize)]}>ctx {contextPct}%</Text>
      <Text color={themeColors.inactive}>)</Text>
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

function getActiveStatusKey(info: MicaUiWorkingStatus): string {
  switch (info.type) {
    case 'connecting':
    case 'thinking':
    case 'streaming':
      return info.type;
    case 'calling_tool':
      return `${info.type}:${info.toolNames?.join(',') ?? ''}`;
    case 'plugin_task':
      return `${info.type}:${info.text}`;
    default:
      return '';
  }
}

function getActiveStatusStartedAt(info: MicaUiWorkingStatus): number | undefined {
  if ('moduleStartedAt' in info && info.moduleStartedAt) return info.moduleStartedAt;
  if ('startedAt' in info && info.startedAt) return info.startedAt;
  return undefined;
}

function getInlineStatusDisplay(info: MicaUiWorkingStatus) {
  if (info.type !== 'calling_tool' || info.elapsedMs == null) return getWorkingStatusDisplay(info);
  return getWorkingStatusDisplay({
    type: 'calling_tool',
    startedAt: info.startedAt,
    moduleStartedAt: info.moduleStartedAt,
    toolNames: info.toolNames,
  });
}

export function WorkingStatus() {
  const info = useScheduleState(workingStatus);
  const currentThinkingText = useScheduleState(thinkingText);
  const currentResponseText = useScheduleState(convResponseText);
  const queueStatus = useScheduleState(queueStatusText);
  const startRef = useRef(0);
  const [elapsed, setElapsed] = useState(0);
  const activeStatusKey = getActiveStatusKey(info);
  const activeStatusStartedAt = getActiveStatusStartedAt(info);
  const activeStatusElapsedMs = info.type === 'calling_tool' ? info.elapsedMs : undefined;

  useEffect(() => {
    if (!activeStatusKey) {
      startRef.current = 0;
      setElapsed(0);
      return;
    }
    startRef.current =
      activeStatusStartedAt ?? (activeStatusElapsedMs != null ? Date.now() - activeStatusElapsedMs : Date.now());
    setElapsed(Date.now() - startRef.current);
    const timer = setInterval(() => setElapsed(Date.now() - startRef.current), runtimeEnv.ui.elapsedRefreshIntervalMs);
    return () => clearInterval(timer);
  }, [activeStatusKey, activeStatusStartedAt, activeStatusElapsedMs]);

  const elapsedText = activeStatusKey && elapsed > 0 ? formatElapsed(elapsed) : '';
  const totalElapsedText = getWorkingStatusTotalElapsed(info, Date.now());
  const statusDisplay = getInlineStatusDisplay(info);
  const statusText = elapsedText ? `${statusDisplay.text} ${elapsedText}` : statusDisplay.text;

  const content = queueStatus ? (
    <Text color={themeColors.inactive} wrap="wrap">
      {queueStatus}
    </Text>
  ) : (
    (() => {
      switch (info.type) {
        case 'connecting':
          return (
            <Box>
              <Spin />
              <Text color={statusDisplay.color}>{statusText}</Text>
            </Box>
          );
        case 'thinking':
          return (
            <Box>
              <Spin />
              <Text color={statusDisplay.color}>{statusText}</Text>
              <Text color={themeColors.inactive}> ↓{estimateTokens(currentThinkingText)} tokens</Text>
            </Box>
          );
        case 'streaming':
          return (
            <Box>
              <Spin />
              <Text color={statusDisplay.color}>{statusText}</Text>
              <Text color={themeColors.inactive}> ↓{estimateTokens(currentResponseText)} tokens</Text>
            </Box>
          );
        case 'calling_tool':
          return (
            <Box>
              <Spin />
              <Text color={statusDisplay.color}>{statusText}</Text>
            </Box>
          );
        case 'plugin_task':
          return (
            <Box>
              <Spin />
              <Text color={statusDisplay.color}>{statusText}</Text>
            </Box>
          );
        case 'error':
          return <Text color={statusDisplay.color}>{statusDisplay.text}</Text>;
        case 'completed':
          return <Text color={statusDisplay.color}>{statusDisplay.text}</Text>;
        default:
          return null;
      }
    })()
  );

  return (
    <Box flexDirection="row">
      <Box flexGrow={1} flexShrink={1}>
        {content}
      </Box>
      <Box flexShrink={0} paddingRight={4} flexDirection="row">
        <StatusInfo />
        {totalElapsedText ? <Text color={themeColors.inactive}> {totalElapsedText}</Text> : null}
      </Box>
    </Box>
  );
}

export const WorkingStatusUI = { renderFn: WorkingStatus };
