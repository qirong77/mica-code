import { Box, Text } from '@anthropic/ink';
import React from 'react';
import { useScheduleState } from '../../hooks/index.js';
import { dropdown, workingStatusAtom, thinkingTextAtom, responseTextAtom } from '../../../../store/ui-state.js';
import { model } from '../../../../store/config.js';
import { C } from '../../data.js';
import { Spin } from '../common/Spin.js';
import { ContextTokens } from '../common/ContextTokens.js';
// ── Types ─────────────────────────────────────────────



// ── 渲染组件 ──────────────────────────────────────────

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  if (ms < 60000) return `${s}s`;
  const m = Math.floor(ms / 60000);
  const sec = ((ms % 60000) / 1000).toFixed(0);
  return `${m}m ${sec}s`;
}

function estimateTokens(text: string): number {
  let ascii = 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x20000 && code <= 0x2CEAF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x3000 && code <= 0x303F) ||
      (code >= 0xFF00 && code <= 0xFFEF)
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
  const dropdownItems = useScheduleState(dropdown.state);
  const thinkingText = useScheduleState(thinkingTextAtom);
  const responseText = useScheduleState(responseTextAtom);

  const hideLeftStatus = dropdownItems.visible && dropdownItems.items.length > 0;

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
            <Text>
              {info.toolNames?.length
                ? info.toolNames.join(', ')
                : 'calling_tool'}
            </Text>
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
            ✓ completed{' '}
            {info.elapsedMs != null ? formatElapsed(info.elapsedMs) : 'Done'}
          </Text>
        );
      default:
        return null;
    }
  })();

  return (
    <Box flexDirection="row">
      <Box flexGrow={1} flexShrink={1}>
        {hideLeftStatus ? null : content}
      </Box>
      <Box flexShrink={0} paddingRight={4} flexDirection="row">
        <Text color={C.dim} wrap="wrap">
          {modelValue} · {effort}
        </Text>
        <ContextTokens />
      </Box>
    </Box>
  );
}

// ── 导出对象 ──────────────────────────────────────────

export const WorkingStatusUI = {
  renderFn: WorkingStatus,
  atomData: workingStatusAtom,
};
