import { useTerminalSize } from '@anthropic/ink';
import useStdin from '@packages/@anthropic/ink/src/hooks/use-stdin.js';
import { cursorPosition } from '@packages/@anthropic/ink/src/core/terminal-querier.js';
import React from 'react';
import { useScheduleState } from './useScheduleState.js';
import { inputBottomDistance } from '../input/state.js';

const MIN_LOG_VIEW_HEIGHT = 5;
const BELOW_INPUT_RESERVED_LINES = 2;

export function getBottomPanelHeight(rows: number, bottomDistance: number, cursorRow: number | null = null): number {
  const fallbackHeight = Math.ceil(rows / 3);
  if (cursorRow !== null) {
    return Math.max(MIN_LOG_VIEW_HEIGHT, rows - cursorRow - BELOW_INPUT_RESERVED_LINES);
  }
  const measuredBottomDistance = Math.min(Math.max(0, bottomDistance), Math.max(0, rows));

  if (measuredBottomDistance <= 0) {
    return Math.max(MIN_LOG_VIEW_HEIGHT, fallbackHeight);
  }

  return Math.max(MIN_LOG_VIEW_HEIGHT, measuredBottomDistance - BELOW_INPUT_RESERVED_LINES);
}

export function useBottomPanelHeight(extraReservedLines = 0) {
  const { columns, rows } = useTerminalSize();
  const { internal_querier: querier } = useStdin();
  const bottomDistance = useScheduleState(inputBottomDistance);
  const [cursorRow, setCursorRow] = React.useState<number | null>(null);
  const nextHeight = getBottomPanelHeight(rows, bottomDistance, cursorRow) - extraReservedLines;
  const stableHeightRef = React.useRef(nextHeight);
  const lastRowsRef = React.useRef(rows);

  React.useEffect(() => {
    if (!querier) {
      setCursorRow(null);
      return;
    }

    let cancelled = false;
    setCursorRow(null);
    void Promise.all([querier.send(cursorPosition()), querier.flush()]).then(([response]) => {
      if (!cancelled && response) setCursorRow(response.row);
    });

    return () => {
      cancelled = true;
    };
  }, [bottomDistance, columns, querier, rows]);

  if (lastRowsRef.current !== rows) {
    lastRowsRef.current = rows;
    stableHeightRef.current = nextHeight;
  } else if (Math.abs(nextHeight - stableHeightRef.current) > 1) {
    stableHeightRef.current = nextHeight;
  }

  return Math.max(1, stableHeightRef.current);
}

/**
 * 计算日志视图的高度
 *
 * 有输入区域布局信息时，日志占满输入框下方的剩余空间；
 * 首次布局尚未测量到输入框位置时，回退到终端高度的 1/3。
 */
export function useLogViewHeight() {
  return useBottomPanelHeight(1);
}
