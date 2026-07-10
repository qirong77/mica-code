import React, { useMemo } from 'react';
import { Text } from '@anthropic/ink';
import { OneLineItem, SelectList, getOneLineColumnWidth } from '../../primitives/index.js';
import type { SelectItem } from '../../primitives/index.js';
import type { MicaUiDropdownItem } from '../../types.js';
import { themeColors } from '../../theme.js';

const MIN_LABEL_COL = 18;

interface CommandSelectItem extends SelectItem {
  source: MicaUiDropdownItem;
}

export function CommandDropdown({
  items,
  selectedIndex,
  title,
  emptyMessage = 'no matching items',
  height,
}: {
  items: MicaUiDropdownItem[];
  selectedIndex: number;
  title?: string;
  emptyMessage?: string;
  height: number;
}): React.ReactNode {
  const labelWidth = useMemo(
    () =>
      getOneLineColumnWidth(
        items.map((item) => item.label),
        { min: MIN_LABEL_COL, max: 34, padding: 1 },
      ),
    [items],
  );
  const selectItems: CommandSelectItem[] = useMemo(
    () => items.map((item) => ({ key: item.key, label: item.label, source: item })),
    [items],
  );

  const renderItem = (item: CommandSelectItem, isSelected: boolean) => {
    const { source } = item;
    const primaryColor = isSelected ? themeColors.accent : themeColors.textSecondary;
    const secondaryColor = isSelected ? themeColors.accent : themeColors.dim;
    return (
      <OneLineItem
        cells={[
          {
            key: 'label',
            content: source.label,
            width: labelWidth,
            color: primaryColor,
          },
          {
            key: 'description',
            content: source.description,
            flexGrow: 1,
            minWidth: 0,
            color: secondaryColor,
            dimColor: !isSelected,
          },
          {
            key: 'suffix',
            content: source.suffix?.text,
            flexShrink: 0,
            color: isSelected ? (source.suffix?.color ?? themeColors.success) : themeColors.dim,
            dimColor: !isSelected,
          },
        ]}
      />
    );
  };

  return (
    <SelectList
      items={selectItems}
      selectedIdx={selectedIndex}
      title={title}
      empty={<Text dimColor>{emptyMessage}</Text>}
      itemGap={0}
      markerWidth={0}
      marker=""
      height={height}
      layout="table"
      renderItem={renderItem}
    />
  );
}
