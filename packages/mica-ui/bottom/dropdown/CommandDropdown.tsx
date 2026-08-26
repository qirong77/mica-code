import React, { useMemo } from 'react';
import { Box, Text } from '@anthropic/ink';
import { Dialog, OneLineItem, SelectList, getOneLineColumnWidth } from '../../primitives/index.js';
import type { SelectItem } from '../../primitives/index.js';
import type { MicaUiDropdownItem, MicaUiDropdownState } from '../../types.js';
import { themeColors } from '../../theme.js';

const MIN_LABEL_COL = 18;

interface CommandSelectItem extends SelectItem {
  source: MicaUiDropdownItem;
}

export function CommandDropdown({
  kind,
  items,
  selectedIndex,
  title,
  emptyMessage = 'no matching items',
  height,
}: {
  kind?: MicaUiDropdownState['kind'];
  items: MicaUiDropdownItem[];
  selectedIndex: number;
  title?: string;
  emptyMessage?: string;
  height?: number;
}): React.ReactNode {
  const labelWidth = useMemo(
    () =>
      getOneLineColumnWidth(
        items.map((item) => item.label),
        { min: kind === 'file' ? 8 : MIN_LABEL_COL, max: 34, padding: 1 },
      ),
    [items, kind],
  );
  const selectItems: CommandSelectItem[] = useMemo(
    () => items.map((item) => ({ key: item.key, label: item.label, source: item })),
    [items],
  );

  const renderItem = (item: CommandSelectItem, isSelected: boolean, index: number) => {
    const { source } = item;
    if (source.kind === 'file') return renderFileItem(source, isSelected, index, labelWidth);

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

  const list = (
    <SelectList
      items={selectItems}
      selectedIdx={selectedIndex}
      title={kind === 'file' ? undefined : title}
      empty={<Text dimColor>{emptyMessage}</Text>}
      itemGap={0}
      markerWidth={0}
      marker=""
      height={height}
      layout="table"
      renderItem={renderItem}
    />
  );

  if (kind === 'file') {
    return <Dialog title={title ?? ''}>{list}</Dialog>;
  }
  return list;
}

function renderFileItem(
  source: MicaUiDropdownItem,
  isSelected: boolean,
  index: number,
  labelWidth: number,
): React.ReactNode {
  const primaryColor = isSelected ? themeColors.accent : themeColors.text;
  const secondaryColor = isSelected ? themeColors.accent : themeColors.dim;
  return (
    <Box
      width="100%"
      backgroundColor={
        isSelected ? themeColors.listRowSelected : index % 2 ? themeColors.listRowAlternate : themeColors.listRow
      }
    >
      <OneLineItem
        gap={1}
        cells={[
          {
            key: 'label',
            content: highlightedLabel(source.label, source.labelHighlights, primaryColor, isSelected),
            width: labelWidth,
            flexGrow: 0,
            flexShrink: 1,
            minWidth: 0,
          },
          {
            key: 'description',
            content: source.description,
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            color: secondaryColor,
            dimColor: !isSelected,
          },
        ]}
      />
    </Box>
  );
}

function highlightedLabel(
  label: string,
  highlights: number[] | undefined,
  color: string,
  isSelected: boolean,
): React.ReactNode {
  const highlighted = new Set(highlights ?? []);
  if (highlighted.size === 0) {
    return (
      <Text color={color} bold={isSelected} wrap="truncate-end">
        {label}
      </Text>
    );
  }

  return (
    <Text color={color} bold={isSelected} wrap="truncate-end">
      {Array.from(label, (character, index) =>
        highlighted.has(index) ? (
          <Text key={index} color={themeColors.accent} bold underline={isSelected}>
            {character}
          </Text>
        ) : (
          character
        ),
      )}
    </Text>
  );
}
