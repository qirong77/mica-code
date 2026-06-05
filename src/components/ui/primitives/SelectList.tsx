import React from 'react';
import { Box, Text } from '@anthropic/ink';
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
  renderItem?: (item: T, isSelected: boolean) => React.ReactNode;
}

export function SelectList<T extends SelectItem>({
  items,
  selectedIdx,
  empty = <Text dimColor>no items</Text>,
  itemGap = 1,
  markerWidth = 2,
  marker = '\u25B6',
  renderItem,
}: SelectListProps<T>): React.ReactNode {
  if (items.length === 0) {
    return <>{empty}</>;
  }

  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
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
      })}
    </Box>
  );
}
