import React, { useRef, useEffect } from 'react';
import { Box, Text, ScrollBox } from '@anthropic/ink';
import type { ScrollBoxHandle } from '@anthropic/ink';
import { C } from '../data.js';

export interface SelectItem {
  key: string;
  label: React.ReactNode;
  suffix?: React.ReactNode;
}

export interface SelectListProps<T extends SelectItem> {
  items: T[];
  selectedIdx: number;
  empty?: React.ReactNode;
  itemGap?: number;
  markerWidth?: number;
  marker?: string;
  maxVisibleItems?: number;
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
      <Box key={item.key} flexDirection="row" marginBottom={i < items.length - 1 ? itemGap : 0}>
        <Box width={markerWidth} flexShrink={0}>
          <Text color={isSelected ? C.accent : C.dim}>
            {isSelected ? marker : ' '}
          </Text>
        </Box>
        {renderItem ? (
          renderItem(item, isSelected)
        ) : (
          <Box flexDirection="row">
            <Text color={isSelected ? C.accent : undefined} bold={isSelected}>
              {item.label}
            </Text>
            {item.suffix ? (
              <Text dimColor={!isSelected} color={isSelected ? C.accent : undefined}>
                {item.suffix}
              </Text>
            ) : null}
          </Box>
        )}
      </Box>
    );
  });
}

export function SelectList<T extends SelectItem>({
  items,
  selectedIdx,
  empty = <Text dimColor>no items</Text>,
  itemGap = 1,
  markerWidth = 2,
  marker = '\u25B6',
  maxVisibleItems = 5,
  renderItem,
}: SelectListProps<T>): React.ReactNode {
  if (items.length === 0) {
    return <>{empty}</>;
  }

  if (items.length <= maxVisibleItems) {
    return (
      <Box flexDirection="column">
        {renderItems(items, selectedIdx, itemGap, markerWidth, marker, renderItem)}
      </Box>
    );
  }

  // scrollHeight tracks the full list; viewport clips to maxVisibleItems
  const visibleRows = maxVisibleItems + (maxVisibleItems - 1) * itemGap;
  const scrollRef = useRef<ScrollBoxHandle>(null);

  useEffect(() => {
    const s = scrollRef.current;
    if (!s) return;
    if (selectedIdx < s.getScrollTop()) {
      s.scrollTo(selectedIdx * (1 + itemGap));
    } else {
      const itemBottom = (selectedIdx + 1) * (1 + itemGap) - itemGap;
      if (itemBottom > s.getScrollTop() + visibleRows) {
        s.scrollTo(itemBottom - visibleRows);
      }
    }
  }, [selectedIdx, itemGap, visibleRows]);

  return (
    <ScrollBox
      ref={scrollRef}
      height={visibleRows}
      flexDirection="column"
    >
      {renderItems(items, selectedIdx, itemGap, markerWidth, marker, renderItem)}
    </ScrollBox>
  );
}
