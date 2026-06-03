import { Box, Text } from '../../../../../packages/@anthropic/ink/src/index.js';
import React, { useEffect, useRef, useState } from 'react';
import { useScheduleState } from '../../hooks/index.js';
import {
  dropdown,
  workingStatusAtom,
  thinkingTextAtom,
  responseTextAtom,
} from '../../../../store/ui-state.js';
import { model } from '../../../../store/config.js';
import { C } from '../../data.js';
import { Spin } from '../common/Spin.js';
import { ContextTokens } from '../common/ContextTokens.js';
import { IfComponent } from '../common/IfComponent.js';

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  if (ms < 60000) return `${s}s`;
  const m = Math.floor(ms / 60000);
  const sec = ((ms % 60000) / 1000).toFixed(0);
  return `${m}m ${sec}s`;
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
        <Text color={C.dim} wrap="wrap">
          {modelValue} · {effort}
        </Text>
        <ContextTokens />
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
