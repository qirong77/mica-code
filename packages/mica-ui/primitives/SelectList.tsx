import React, { useRef, useEffect } from 'react';
import { Box, Text, ScrollBox } from '@anthropic/ink';
import type { ScrollBoxHandle } from '@anthropic/ink';
import { themeColors } from '../theme.js';
import { useBottomPanelHeight } from '../hooks/useLogViewHeight.js';
import { OneLineItem } from './OneLineItem.js';

export interface SelectItem {
  key: string;
  label: React.ReactNode;
  status?: React.ReactNode;
  description?: React.ReactNode;
  suffix?: React.ReactNode;
  labelWidth?: number | string;
  labelMaxWidth?: number | string;
}

export interface SelectListProps<T extends SelectItem> {
  items: T[];
  selectedIdx: number;
  title?: React.ReactNode;
  empty?: React.ReactNode;
  itemGap?: number;
  markerWidth?: number;
  marker?: string;
  maxVisibleItems?: number;
  adaptiveHeight?: boolean;
  reservedRows?: number;
  renderItem?: (item: T, isSelected: boolean) => React.ReactNode;
}

function renderItems<T extends SelectItem>(
  items: T[],
  selectedIdx: number,
  itemGap: number,
  markerWidth: number,
  marker: string,
  renderItem?: (item: T, isSelected: boolean) => React.ReactNode,
) {
  return items.map((item, i) => {
    const isSelected = i === selectedIdx;
    return (
      <Box
        key={item.key}
        flexDirection="row"
        width="100%"
        minWidth={0}
        marginBottom={i < items.length - 1 ? itemGap : 0}
      >
        <Box width={markerWidth} flexShrink={0}>
          <Text color={isSelected ? themeColors.accent : themeColors.dim}>{isSelected ? marker : ' '}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {renderItem ? renderItem(item, isSelected) : <DefaultSelectItem item={item} isSelected={isSelected} />}
        </Box>
      </Box>
    );
  });
}

function DefaultSelectItem({ item, isSelected }: { item: SelectItem; isSelected: boolean }): React.ReactNode {
  const hasDescription = item.description !== undefined && item.description !== null && item.description !== '';

  return (
    <OneLineItem
      cells={[
        {
          key: 'status',
          content: item.status,
          flexShrink: 0,
        },
        {
          key: 'label',
          content: item.label,
          width: item.labelWidth,
          maxWidth: item.labelMaxWidth ?? (hasDescription ? '45%' : undefined),
          flexGrow: item.labelWidth ? 0 : hasDescription ? 0 : 1,
          flexShrink: 1,
          minWidth: 0,
          color: isSelected ? themeColors.accent : undefined,
          bold: isSelected,
        },
        {
          key: 'description',
          content: item.description,
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
          color: isSelected ? themeColors.accent : undefined,
          dimColor: !isSelected,
        },
        {
          key: 'suffix',
          content: item.suffix,
          flexShrink: 0,
          color: isSelected ? themeColors.accent : undefined,
          dimColor: !isSelected,
        },
      ]}
    />
  );
}

export function SelectList<T extends SelectItem>({
  items,
  selectedIdx,
  title,
  empty = <Text dimColor>no items</Text>,
  itemGap = 1,
  markerWidth = 2,
  marker = '\u25B6',
  maxVisibleItems = 5,
  adaptiveHeight = true,
  reservedRows = title ? 1 : 0,
  renderItem,
}: SelectListProps<T>): React.ReactNode {
  if (adaptiveHeight) {
    return (
      <AdaptiveSelectList
        items={items}
        selectedIdx={selectedIdx}
        title={title}
        empty={empty}
        itemGap={itemGap}
        markerWidth={markerWidth}
        marker={marker}
        maxVisibleItems={maxVisibleItems}
        reservedRows={reservedRows}
        renderItem={renderItem}
      />
    );
  }

  return (
    <SelectListContent
      items={items}
      selectedIdx={selectedIdx}
      title={title}
      empty={empty}
      itemGap={itemGap}
      markerWidth={markerWidth}
      marker={marker}
      visibleItemLimit={maxVisibleItems}
      renderItem={renderItem}
    />
  );
}

function AdaptiveSelectList<T extends SelectItem>({
  items,
  selectedIdx,
  title,
  empty,
  itemGap,
  markerWidth,
  marker,
  maxVisibleItems,
  reservedRows,
  renderItem,
}: Omit<SelectListProps<T>, 'adaptiveHeight'> & {
  empty: React.ReactNode;
  itemGap: number;
  markerWidth: number;
  marker: string;
  maxVisibleItems: number;
  reservedRows: number;
}): React.ReactNode {
  const panelHeight = useBottomPanelHeight(reservedRows);
  const adaptiveVisibleItems = Math.max(1, Math.floor((panelHeight + itemGap) / (1 + itemGap)));
  const visibleItemLimit = Math.max(maxVisibleItems, adaptiveVisibleItems);

  return (
    <SelectListContent
      items={items}
      selectedIdx={selectedIdx}
      title={title}
      empty={empty}
      itemGap={itemGap}
      markerWidth={markerWidth}
      marker={marker}
      visibleItemLimit={visibleItemLimit}
      renderItem={renderItem}
    />
  );
}

function SelectListContent<T extends SelectItem>({
  items,
  selectedIdx,
  title,
  empty,
  itemGap,
  markerWidth,
  marker,
  visibleItemLimit,
  renderItem,
}: {
  items: T[];
  selectedIdx: number;
  title?: React.ReactNode;
  empty: React.ReactNode;
  itemGap: number;
  markerWidth: number;
  marker: string;
  visibleItemLimit: number;
  renderItem?: (item: T, isSelected: boolean) => React.ReactNode;
}): React.ReactNode {
  if (items.length === 0) return <>{empty}</>;

  const body =
    items.length <= visibleItemLimit ? (
      <Box flexDirection="column" width="100%" minWidth={0}>
        {renderItems(items, selectedIdx, itemGap, markerWidth, marker, renderItem)}
      </Box>
    ) : (
      <ScrollBody
        items={items}
        selectedIdx={selectedIdx}
        visibleItems={visibleItemLimit}
        itemGap={itemGap}
        markerWidth={markerWidth}
        marker={marker}
        renderItem={renderItem}
      />
    );

  if (!title) return body;
  return (
    <Box flexDirection="column">
      <Box paddingBottom={1}>{typeof title === 'string' ? <Text dimColor>{title}</Text> : title}</Box>
      {body}
    </Box>
  );
}

function ScrollBody<T extends SelectItem>({
  items,
  selectedIdx,
  visibleItems,
  itemGap,
  markerWidth,
  marker,
  renderItem,
}: {
  items: T[];
  selectedIdx: number;
  visibleItems: number;
  itemGap: number;
  markerWidth: number;
  marker: string;
  renderItem?: (item: T, isSelected: boolean) => React.ReactNode;
}) {
  const visibleRows = visibleItems + (visibleItems - 1) * itemGap;
  const scrollRef = useRef<ScrollBoxHandle>(null);
  useEffect(() => {
    const s = scrollRef.current;
    if (!s) return;
    if (selectedIdx < s.getScrollTop()) s.scrollTo(selectedIdx * (1 + itemGap));
    else {
      const itemBottom = (selectedIdx + 1) * (1 + itemGap) - itemGap;
      if (itemBottom > s.getScrollTop() + visibleRows) s.scrollTo(itemBottom - visibleRows);
    }
  }, [selectedIdx, itemGap, visibleRows]);

  return (
    <ScrollBox ref={scrollRef} height={visibleRows} flexDirection="column" width="100%" minWidth={0}>
      {renderItems(items, selectedIdx, itemGap, markerWidth, marker, renderItem)}
    </ScrollBox>
  );
}
