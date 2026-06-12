import React, { useMemo, useRef, useEffect } from 'react';
import { Box, Text, ScrollBox } from '@anthropic/ink';
import type { ScrollBoxHandle } from '@anthropic/ink';
import { C } from '../data.js';
import { useScheduleState } from '../hooks/index.js';
import { inputBottomDistanceAtom } from '../../store/ui-state.js';

const DEFAULT_OVERHEAD = 6;

export interface SelectItem {
  key: string;
  label: React.ReactNode;
  description?: string;
  suffix?: React.ReactNode;
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
  heightEveryRow?: number;
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
  title,
  empty = <Text dimColor>no items</Text>,
  itemGap = 1,
  markerWidth = 2,
  marker = '\u25B6',
  maxVisibleItems: explicitMax,
  heightEveryRow = 1,
  renderItem,
}: SelectListProps<T>): React.ReactNode {
  const bottomDistance = useScheduleState(inputBottomDistanceAtom);

  const maxVisibleItems = useMemo(() => {
    if (explicitMax !== undefined) return explicitMax;
    if (bottomDistance <= 0) return 5;
    return Math.max(3, Math.floor((bottomDistance - DEFAULT_OVERHEAD) / heightEveryRow));
  }, [explicitMax, bottomDistance, heightEveryRow]);
  if (items.length === 0) {
    return <>{empty}</>;
  }

  const body =
    items.length <= maxVisibleItems ? (
      <Box flexDirection="column">
        {renderItems(items, selectedIdx, itemGap, markerWidth, marker, renderItem)}
      </Box>
    ) : (
      <ScrollBody
        items={items}
        selectedIdx={selectedIdx}
        maxVisibleItems={maxVisibleItems}
        itemGap={itemGap}
        markerWidth={markerWidth}
        marker={marker}
        renderItem={renderItem}
      />
    );

  if (!title) return body;

  return (
    <Box flexDirection="column">
      <Box paddingBottom={1}>
        {typeof title === 'string' ? <Text dimColor>{title}</Text> : title}
      </Box>
      {body}
    </Box>
  );
}

function ScrollBody<T extends SelectItem>({
  items,
  selectedIdx,
  maxVisibleItems,
  itemGap,
  markerWidth,
  marker,
  renderItem,
}: {
  items: T[];
  selectedIdx: number;
  maxVisibleItems: number;
  itemGap: number;
  markerWidth: number;
  marker: string;
  renderItem?: (item: T, isSelected: boolean) => React.ReactNode;
}) {
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
    <ScrollBox ref={scrollRef} height={visibleRows} flexDirection="column">
      {renderItems(items, selectedIdx, itemGap, markerWidth, marker, renderItem)}
    </ScrollBox>
  );
}
