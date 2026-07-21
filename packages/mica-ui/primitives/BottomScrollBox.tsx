import React from 'react';
import { ScrollBox } from '@anthropic/ink';
import type { ScrollBoxHandle, ScrollBoxProps } from '@packages/@anthropic/ink/src/components/ScrollBox.js';
import { useLogViewHeight } from '../hooks/useLogViewHeight.js';

export type BottomScrollBoxProps = Omit<ScrollBoxProps, 'height' | 'maxHeight'> & {
  children?: React.ReactNode;
  height?: number;
  maxHeight?: number;
  bottomReservedRows?: number;
  ref?: React.Ref<ScrollBoxHandle>;
  flexDirection?: 'row' | 'column';
};

function normalizeHeight(value: number): number {
  return Math.max(1, Math.floor(value));
}

export function BottomScrollBox({
  height,
  maxHeight,
  bottomReservedRows = 4,
  flexDirection = 'column',
  width = '100%',
  minWidth = 0,
  ...props
}: BottomScrollBoxProps): React.ReactNode {
  const logViewHeight = useLogViewHeight();
  const defaultHeight = normalizeHeight(logViewHeight - bottomReservedRows);
  const resolvedHeight =
    height !== undefined ? normalizeHeight(height) : maxHeight === undefined ? defaultHeight : undefined;
  const resolvedMaxHeight = maxHeight === undefined ? undefined : normalizeHeight(maxHeight);
  const sizeProps: { height?: number; maxHeight?: number } = {
    ...(resolvedHeight !== undefined ? { height: resolvedHeight } : {}),
    ...(resolvedMaxHeight !== undefined ? { maxHeight: resolvedMaxHeight } : {}),
  };
  return <ScrollBox {...sizeProps} flexDirection={flexDirection} width={width} minWidth={minWidth} {...props} />;
}
