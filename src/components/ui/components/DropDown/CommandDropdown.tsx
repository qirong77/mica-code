import React, { useMemo } from 'react';
import { Box, Text, type Color, stringWidth } from '@anthropic/ink';
import { C } from '../../data.js';

export interface DropdownItem {
  key: string;
  label: string;
  description?: string;
  suffix?: { text: string; color?: string };
}

const MAX_LABEL_COL = 40;
const MIN_LABEL_COL = 20;

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
    const maxW = Math.max(...items.map((it) => stringWidth(it.label)));
    return Math.max(MIN_LABEL_COL, Math.min(MAX_LABEL_COL, maxW));
  }, [items]);

  if (items.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>{emptyMessage}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" >
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
            <Box width={labelWidth + 2}>
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
