import { Box, Text } from '@anthropic/ink';
import React, { useEffect, useRef, useState } from 'react';
import { useScheduleState } from '../../hooks/index.js';
import {
  dropdown,
  workingStatusAtom,
  thinkingTextAtom,
  responseTextAtom,
} from '../../../../store/ui-state.js';
import { model } from '../../../../store/config.js';
import { contextSizeAtom, cacheHitRateAtom } from '../../../../store/conversation.js';
import { C } from '../../data.js';
import { Spin } from '../common/Spin.js';
import { IfComponent } from '../common/IfComponent.js';
import { formatElapsed } from '../../../../utils/format.js';

const CTX_THRESHOLDS = [0.1, 0.3, 0.5, 0.8] as const;
const CTX_COLORS = [C.dim, C.info, C.warning, '#FF9800', C.error] as const;

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function getCtxColorIndex(ratio: number): number {
  for (let i = CTX_THRESHOLDS.length - 1; i >= 0; i--) {
    if (ratio >= CTX_THRESHOLDS[i]) return i + 1;
  }
  return 0;
}

function StatusInfo() {
  const modelValue = useScheduleState(model.name);
  const effort = useScheduleState(model.effort);
  const contextSize = useScheduleState(contextSizeAtom);
  const windowSize = useScheduleState(model.contextWindowSize);
  const cacheHitRate = useScheduleState(cacheHitRateAtom);

  const tokenStr = formatTokens(contextSize);
  const cachePct = (cacheHitRate * 100).toFixed(0);

  if (contextSize <= 0 || windowSize <= 0) {
    return (
      <Text color={C.dim} wrap="wrap">
        {modelValue}_{effort}
      </Text>
    );
  }

  const ratio = contextSize / windowSize;
  const color = CTX_COLORS[getCtxColorIndex(ratio)];

  return (
    <Text color={color} wrap="wrap">
      {modelValue}_{effort} {tokenStr} ({cachePct}% token cached)
    </Text>
  );
}

function isEndWorkingStatus(type: string) {
  return type === 'completed' || type === 'error' || type === 'idle';
}

function estimateTokens(text: string): number {
  let ascii = 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x20000 && code <= 0x2ceaf) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    } else {
      ascii++;
    }
  }
  return Math.max(1, Math.ceil(ascii / 4 + cjk / 1.5));
}

export function WorkingStatus() {
  const info = useScheduleState(workingStatusAtom);
  const modelValue = useScheduleState(model.name);
  const effort = useScheduleState(model.effort);
  const thinkingText = useScheduleState(thinkingTextAtom);
  const responseText = useScheduleState(responseTextAtom);
  const startRef = useRef(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (info.type === 'idle' || info.type === 'completed' || info.type === 'error') {
      startRef.current = 0;
      setElapsed(0);
      return;
    }
    if (!startRef.current) {
      startRef.current = Date.now();
    }
    const timer = setInterval(() => {
      setElapsed(Date.now() - startRef.current);
    }, 100);
    return () => clearInterval(timer);
  }, [info.type]);

  const displayElapsed =
    info.type === 'completed' || info.type === 'calling_tool'
      ? (info.elapsedMs ?? elapsed)
      : elapsed;

  const elapsedText = displayElapsed > 0 ? formatElapsed(displayElapsed) : '';

  const content = (() => {
    switch (info.type) {
      case 'connecting':
        return (
          <Box>
            <Spin />
            <Text>connecting</Text>
          </Box>
        );
      case 'thinking':
        return (
          <Box>
            <Spin />
            <Text>thinking</Text>
            <Text color={C.dim}> ↓{estimateTokens(thinkingText)} tokens</Text>
          </Box>
        );
      case 'streaming':
        return (
          <Box>
            <Spin />
            <Text>streaming</Text>
            <Text color={C.dim}> ↓{estimateTokens(responseText)} tokens</Text>
          </Box>
        );
      case 'calling_tool':
        return (
          <Box>
            <Spin />
            <Text>{info.toolNames?.length ? info.toolNames.join(', ') : 'calling_tool'}</Text>
            {info.elapsedMs != null && (
              <Text color={C.dim}> ({formatElapsed(info.elapsedMs)})</Text>
            )}
          </Box>
        );
      case 'error':
        return <Text color={C.error}>✗ {info.message}</Text>;
      case 'completed':
        return (
          <Text color={C.success}>
            ✓ completed {info.elapsedMs != null ? formatElapsed(info.elapsedMs) : 'Done'}
          </Text>
        );
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
        <IfComponent condition={!isEndWorkingStatus(info.type)}>
          <Text color={C.dim}> {elapsedText}</Text>
        </IfComponent>
      </Box>
    </Box>
  );
}

// ── 导出对象 ──────────────────────────────────────────

export const WorkingStatusUI = {
  renderFn: WorkingStatus,
  atomData: workingStatusAtom,
};
