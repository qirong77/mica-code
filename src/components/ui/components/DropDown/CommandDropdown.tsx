import React, { useMemo } from 'react';
import { Box, Text, type Color, stringWidth } from '@anthropic/ink';
import { C } from '../../data.js';

export interface DropdownItem {
  key: string;
  label: string;
  description?: string;
  suffix?: { text: string; color?: string };
}

const MIN_LABEL_COL = 18;
const GAP = 3;
const SIDE_MARGIN = 4;

function truncateToWidth(str: string, maxWidth: number): string {
  if (stringWidth(str) <= maxWidth) return str;
  let result = '';
  let w = 0;
  for (const ch of str) {
    const cw = stringWidth(ch);
    if (w + cw > maxWidth - 1) return result + '…';
    result += ch;
    w += cw;
  }
  return result;
}

export function CommandDropdown({
  items,
  selectedIndex,
  title,
  emptyMessage = 'no matching items',
}: {
  items: DropdownItem[];
  selectedIndex: number;
  title?: string;
  emptyMessage?: string;
}): React.ReactNode {
  const labelWidth = useMemo(() => {
    if (items.length === 0) return MIN_LABEL_COL;

    const maxLabelW = Math.max(...items.map((it) => stringWidth(it.label)));
    const terminalW = process.stdout.columns || 80;
    const availableW = terminalW - SIDE_MARGIN;

    const maxRightW = Math.max(
      ...items.map((it) => {
        const descW = it.description ? stringWidth(it.description) : 0;
        const suffixW = it.suffix ? stringWidth(it.suffix.text) + 1 : 0;
        return descW + suffixW;
      }),
    );

    if (maxLabelW + GAP + maxRightW <= availableW) {
      return Math.max(MIN_LABEL_COL, maxLabelW);
    }

    const labelBudget = Math.floor(availableW * 0.48);
    return Math.max(MIN_LABEL_COL, Math.min(labelBudget, maxLabelW));
  }, [items]);

  if (items.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>{emptyMessage}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={Math.floor(SIDE_MARGIN / 2)}>
      {title && (
        <Box paddingBottom={1}>
          <Text dimColor>{title}</Text>
        </Box>
      )}
      {items.map((item, i) => {
        const isSelected = i === selectedIndex;
        const displayLabel = truncateToWidth(item.label, labelWidth);
        return (
          <Box key={item.key}>
            <Box width={labelWidth + GAP}>
              <Text color={isSelected ? 'claude' : 'inactive'}>{displayLabel}</Text>
            </Box>
            <Box>
              {item.description && <Text color={isSelected ? 'claude' : 'inactive'}>{item.description}</Text>}
              {item.suffix && (
                <Text color={(item.suffix.color ?? C.success) as Color}>{item.suffix.text}</Text>
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
