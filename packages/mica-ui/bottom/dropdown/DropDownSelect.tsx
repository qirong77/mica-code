import { Box } from '@anthropic/ink';
import React, { useMemo } from 'react';
import { useScheduleState } from '../../hooks/index.js';
import { CommandDropdown } from './CommandDropdown.js';
import { inputValue } from './data.js';
import { DropDownUI } from './index.js';
import { inputBottomDistance } from '../../input/data.js';

const DEFAULT_OVERHEAD = 6;

export function DropDownSelect() {
  const dropdown = useScheduleState(DropDownUI.atomData.dropdown);
  const filterValue = useScheduleState(inputValue);
  const bottomDistance = useScheduleState(inputBottomDistance);

  const filteredItems = useMemo(() => {
    if (!dropdown.visible) return dropdown.items;
    const filter = filterValue.toLowerCase();
    if (!filter) return dropdown.items;
    return dropdown.items.filter((item) => item.label.toLowerCase().includes(filter));
  }, [dropdown.items, dropdown.visible, filterValue]);

  const selectedIndex = useMemo(
    () => Math.min(dropdown.selectedIndex, Math.max(0, filteredItems.length - 1)),
    [dropdown.selectedIndex, filteredItems.length],
  );
  const maxVisibleItems = useMemo(() => {
    if (bottomDistance <= 0) return 5;
    return Math.max(3, Math.floor(bottomDistance - DEFAULT_OVERHEAD));
  }, [bottomDistance]);

  if (!dropdown.visible) return null;

  return (
    <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
      <CommandDropdown
        items={filteredItems}
        selectedIndex={selectedIndex}
        title={dropdown.title}
        emptyMessage={dropdown.emptyMessage}
        maxVisibleItems={maxVisibleItems}
      />
    </Box>
  );
}
