import React, { useMemo } from 'react';
import { Box, Text } from '@anthropic/ink';
import { OneLineItem, SelectList, getOneLineColumnWidth } from '../../primitives/index.js';
import type { SelectItem } from '../../primitives/index.js';
import type { MicaUiDropdownItem } from '../../types.js';
import { themeColors } from '../../theme.js';

const MIN_LABEL_COL = 18;

function useLabelWidth(items: MicaUiDropdownItem[]): number {
  return useMemo(() => {
    return getOneLineColumnWidth(
      items.map((item) => item.label),
      { min: MIN_LABEL_COL, max: 34, padding: 1 },
    );
  }, [items]);
}

export function CommandDropdown({
  items,
  selectedIndex,
  title,
  emptyMessage = 'no matching items',
  maxVisibleItems,
}: {
  items: MicaUiDropdownItem[];
  selectedIndex: number;
  title?: string;
  emptyMessage?: string;
  maxVisibleItems?: number;
}): React.ReactNode {
  const labelWidth = useLabelWidth(items);
  const selectItems: SelectItem[] = useMemo(
    () => items.map((it) => ({ key: it.key, label: it.label, description: it.description, suffix: it.suffix?.text })),
    [items],
  );

  const renderItem = (item: SelectItem, isSelected: boolean) => {
    const orig = items.find((it) => it.key === item.key);
    const primaryColor = isSelected ? themeColors.accent : themeColors.textSecondary;
    const secondaryColor = isSelected ? themeColors.accent : themeColors.dim;
    return (
      <OneLineItem
        cells={[
          {
            key: 'label',
            content: orig?.label ?? '',
            width: labelWidth,
            color: primaryColor,
          },
          {
            key: 'description',
            content: orig?.description,
            flexGrow: 1,
            minWidth: 0,
            color: secondaryColor,
            dimColor: !isSelected,
          },
          {
            key: 'suffix',
            content: orig?.suffix?.text,
            flexShrink: 0,
            color: isSelected ? (orig?.suffix?.color ?? themeColors.success) : themeColors.dim,
            dimColor: !isSelected,
          },
        ]}
      />
    );
  };

  return (
    <Box>
      <SelectList
        items={selectItems}
        selectedIdx={selectedIndex}
        title={title}
        empty={<Text dimColor>{emptyMessage}</Text>}
        itemGap={0}
        markerWidth={0}
        marker=""
        maxVisibleItems={maxVisibleItems}
        adaptiveHeight={false}
        layout="table"
        scrollIndicators={false}
        renderItem={renderItem}
      />
    </Box>
  );
}
