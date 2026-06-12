import React, { useMemo } from 'react';
import { Box, Text, type Color, stringWidth } from '@anthropic/ink';
import { Dialog, KeyHints, SelectList } from '../primitives/index.js';
import type { SelectItem } from '../primitives/index.js';
import type { DropdownItem } from '../../store/ui-state.js';
import { C } from '../data.js';

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

function useLabelWidth(items: DropdownItem[]): number {
  return useMemo(() => {
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
  const labelWidth = useLabelWidth(items);

  const selectItems: SelectItem[] = useMemo(
    () =>
      items.map((it) => ({
        key: it.key,
        label: it.label,
        description: it.description,
        suffix: it.suffix ? it.suffix.text : undefined,
      })),
    [items],
  );

  const renderItem = (item: SelectItem, isSelected: boolean) => {
    const orig = items.find((it) => it.key === item.key);
    return (
      <Box flexDirection="row">
        <Box width={labelWidth + GAP}>
          <Text color={isSelected ? C.accent : C.dim}>
            {truncateToWidth(orig?.label ?? '', labelWidth)}
          </Text>
        </Box>
        <Box>
          {orig?.description && (
            <Text color={isSelected ? C.accent : C.dim}>{orig.description}</Text>
          )}
          {orig?.suffix && (
            <Text color={(orig.suffix.color ?? C.success) as Color}>
              {orig.suffix.text}
            </Text>
          )}
        </Box>
      </Box>
    );
  };

  return (
    <Box paddingX={Math.floor(SIDE_MARGIN / 2)}>
    <Dialog title="" footer={<KeyHints hints={['↑↓ navigate', '↵ select', 'esc cancel']} />}>
      <SelectList
        items={selectItems}
        selectedIdx={selectedIndex}
        title={title}
        empty={<Text dimColor>{emptyMessage}</Text>}
        itemGap={0}
        markerWidth={0}
        marker=""
        heightEveryRow={1}
        renderItem={renderItem}
      />
    </Dialog>

    </Box>
  );
}