import { Box } from '@anthropic/ink';
import { useMemo } from 'react';
import { useScheduleState } from '../../hooks/index.js';
import { CommandDropdown } from './CommandDropdown.js';
import { state } from './state.js';

export function DropDownSelect() {
  const dropdown = useScheduleState(state);

  const selectedIndex = useMemo(
    () => Math.min(dropdown.selectedIndex, Math.max(0, dropdown.items.length - 1)),
    [dropdown.selectedIndex, dropdown.items.length],
  );

  if (!dropdown.visible) return null;

  return (
    <Box flexDirection="column" flexGrow={1} minWidth={0}>
      <CommandDropdown
        items={dropdown.items}
        selectedIndex={selectedIndex}
        title={dropdown.title}
        emptyMessage={dropdown.emptyMessage}
      />
    </Box>
  );
}
