import { Box } from '../../../../../packages/@anthropic/ink/src';
import React, { useMemo } from 'react';
import { useScheduleState } from '../../hooks';
import { CommandDropdown } from './CommandDropdown';
import { DropDownUI } from './index.js';
import { dropdown as dropdownAtoms } from '../../../../store/ui-state.js';


export function DropDownSelect() {
  const dropdown = useScheduleState(DropDownUI.atomData.dropdown);
  const inputValue = useScheduleState(dropdownAtoms.inputValue);

  const filteredItems = useMemo(() => {
    if (!dropdown.visible) return dropdown.items;
    const filter = inputValue.toLowerCase();
    if (!filter) return dropdown.items;
    return dropdown.items.filter((item) => item.label.toLowerCase().includes(filter));
  }, [dropdown.items, dropdown.visible, inputValue]);

  const selectedIndex = useMemo(
    () => Math.min(dropdown.selectedIndex, Math.max(0, filteredItems.length - 1)),
    [dropdown.selectedIndex, filteredItems.length],
  );

  if (!dropdown.visible) return null;

  return (
    <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
      <CommandDropdown
        items={filteredItems}
        selectedIndex={selectedIndex}
        title={dropdown.title}
        emptyMessage={dropdown.emptyMessage}
      />
    </Box>
  );
}
