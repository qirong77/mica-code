import { Box } from '@anthropic/ink';
import { useMemo } from 'react';
import { useScheduleState } from '../../hooks/index.js';
import { CommandDropdown } from './CommandDropdown.js';
import { state } from './state.js';
import { inputBottomDistance } from '../../input/state.js';

const DEFAULT_OVERHEAD = 10;

export function DropDownSelect() {
  const dropdown = useScheduleState(state);
  const bottomDistance = useScheduleState(inputBottomDistance);

  const selectedIndex = useMemo(
    () => Math.min(dropdown.selectedIndex, Math.max(0, dropdown.items.length - 1)),
    [dropdown.selectedIndex, dropdown.items.length],
  );
  const maxVisibleItems = useMemo(() => {
    if (bottomDistance <= 0) return 5;
    return Math.max(3, Math.floor(bottomDistance - DEFAULT_OVERHEAD));
  }, [bottomDistance]);

  if (!dropdown.visible) return null;

  return (
    <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
      <CommandDropdown
        items={dropdown.items}
        selectedIndex={selectedIndex}
        title={dropdown.title}
        emptyMessage={dropdown.emptyMessage}
        maxVisibleItems={maxVisibleItems}
      />
    </Box>
  );
}
