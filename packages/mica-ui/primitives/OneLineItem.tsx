import React from 'react';
import { Box, Text, stringWidth } from '@anthropic/ink';

type BoxSize = number | string;
type TextWrap = 'wrap' | 'truncate' | 'truncate-start' | 'truncate-middle' | 'truncate-end';

export type OneLineItemCell = {
  key: string;
  content: React.ReactNode;
  width?: BoxSize;
  minWidth?: BoxSize;
  maxWidth?: BoxSize;
  flexBasis?: BoxSize;
  flexGrow?: number;
  flexShrink?: number;
  paddingLeft?: number;
  paddingRight?: number;
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
  wrap?: TextWrap;
  truncate?: boolean;
};

export interface OneLineItemProps {
  cells: OneLineItemCell[];
  gap?: number;
  width?: BoxSize;
}

export type OneLineColumnWidthOptions = {
  min?: number;
  max?: number;
  fallback?: number;
  padding?: number;
};

export function getOneLineColumnWidth(
  values: Iterable<string | number | null | undefined>,
  { min = 0, max = Number.POSITIVE_INFINITY, fallback = min, padding = 0 }: OneLineColumnWidthOptions = {},
): number {
  let widest = fallback;
  let hasValue = false;

  for (const value of values) {
    if (value === null || value === undefined) continue;
    hasValue = true;
    widest = Math.max(widest, stringWidth(String(value)) + padding);
  }

  const lower = Math.max(0, min);
  const upper = Math.max(lower, max);
  return Math.max(lower, Math.min(upper, hasValue ? widest : fallback));
}

export function OneLineItem({ cells, gap = 1, width = '100%' }: OneLineItemProps): React.ReactNode {
  const visibleCells = cells.filter(
    (cell) => cell.content !== null && cell.content !== undefined && cell.content !== false,
  );

  return (
    <Box flexDirection="row" width={width} minWidth={0} columnGap={gap} overflowX="hidden" overflowY="hidden">
      {visibleCells.map((cell) => {
        const flexible = (cell.flexGrow ?? 0) > 0;
        const boxProps = {
          ...(cell.width !== undefined ? { width: cell.width } : {}),
          ...(cell.minWidth !== undefined || flexible ? { minWidth: cell.minWidth ?? 0 } : {}),
          ...(cell.maxWidth !== undefined ? { maxWidth: cell.maxWidth } : {}),
          ...(cell.flexBasis !== undefined || flexible ? { flexBasis: cell.flexBasis ?? 0 } : {}),
          flexGrow: cell.flexGrow ?? 0,
          flexShrink: cell.flexShrink ?? (flexible ? 1 : 0),
          ...(cell.paddingLeft !== undefined ? { paddingLeft: cell.paddingLeft } : {}),
          ...(cell.paddingRight !== undefined ? { paddingRight: cell.paddingRight } : {}),
        };

        return (
          <Box key={cell.key} {...boxProps} overflowX="hidden" overflowY="hidden">
            {renderCellContent(cell)}
          </Box>
        );
      })}
    </Box>
  );
}

function renderCellContent(cell: OneLineItemCell): React.ReactNode {
  if (typeof cell.content === 'string' || typeof cell.content === 'number') {
    return (
      <Text
        color={cell.color}
        dimColor={cell.dimColor}
        bold={cell.bold}
        italic={cell.italic}
        underline={cell.underline}
        strikethrough={cell.strikethrough}
        inverse={cell.inverse}
        wrap={cell.wrap ?? (cell.truncate === false ? 'wrap' : 'truncate-end')}
      >
        {cell.content}
      </Text>
    );
  }

  return cell.content;
}
