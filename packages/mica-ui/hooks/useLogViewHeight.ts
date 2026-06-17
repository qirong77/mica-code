import { useTerminalSize } from '@anthropic/ink';
import React from 'react';
import { useScheduleState } from './useScheduleState';
import { inputBottomDistance } from '../input/data.js';

const MIN_LOG_VIEW_HEIGHT = 5;
const BELOW_INPUT_RESERVED_LINES = 2;

export function getLogViewHeight(
  rows: number,
  bottomDistance: number,
): number {
  const fallbackHeight = Math.ceil(rows / 3);

  if (bottomDistance <= 0) {
    return Math.max(MIN_LOG_VIEW_HEIGHT, fallbackHeight);
  }

  return Math.max(
    MIN_LOG_VIEW_HEIGHT,
    bottomDistance - BELOW_INPUT_RESERVED_LINES,
  );
}

/**
 * 计算日志视图的高度
 *
 * 有输入区域布局信息时，日志占满输入框下方的剩余空间；
 * 首次布局尚未测量到输入框位置时，回退到终端高度的 1/3。
 */
export function useLogViewHeight() {
  const { rows } = useTerminalSize();
  const bottomDistance = useScheduleState(inputBottomDistance);
  const nextHeight = getLogViewHeight(rows, bottomDistance);
  const stableHeightRef = React.useRef(nextHeight);
  const lastRowsRef = React.useRef(rows);

  if (lastRowsRef.current !== rows) {
    lastRowsRef.current = rows;
    stableHeightRef.current = nextHeight;
  } else if (Math.abs(nextHeight - stableHeightRef.current) > 1) {
    stableHeightRef.current = nextHeight;
  }

  return stableHeightRef.current;
}
