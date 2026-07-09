import { useTerminalSize } from '@anthropic/ink';
import React from 'react';
import { useScheduleState } from './useScheduleState.js';
import { inputBottomDistance } from '../input/state.js';

const MIN_LOG_VIEW_HEIGHT = 5;
const BELOW_INPUT_RESERVED_LINES = 2;

function getBottomPanelHeight(rows: number, bottomDistance: number): number {
  const fallbackHeight = Math.ceil(rows / 3);
  const measuredBottomDistance = Math.min(Math.max(0, bottomDistance), Math.max(0, rows));

  if (measuredBottomDistance <= 0) {
    return Math.max(MIN_LOG_VIEW_HEIGHT, fallbackHeight);
  }

  return Math.max(MIN_LOG_VIEW_HEIGHT, measuredBottomDistance - BELOW_INPUT_RESERVED_LINES);
}

export function useBottomPanelHeight(extraReservedLines = 0) {
  const { rows } = useTerminalSize();
  const bottomDistance = useScheduleState(inputBottomDistance);
  const nextHeight = getBottomPanelHeight(rows, bottomDistance) - extraReservedLines;
  const stableHeightRef = React.useRef(nextHeight);
  const lastRowsRef = React.useRef(rows);

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
