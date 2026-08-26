import { useScheduleState } from '../../hooks/index.js';
import { useBottomPanelHeight } from '../../hooks/useLogViewHeight.js';
import { CommandDropdown } from './CommandDropdown.js';
import { state } from './state.js';

export function DropDownSelect() {
  const dropdown = useScheduleState(state);
  const height = useBottomPanelHeight();

  const selectedIndex = Math.min(dropdown.selectedIndex, Math.max(0, dropdown.items.length - 1));

  if (!dropdown.visible) return null;

  return (
    <CommandDropdown
      kind={dropdown.kind}
      items={dropdown.items}
      selectedIndex={selectedIndex}
      title={dropdown.title}
      emptyMessage={dropdown.emptyMessage}
      height={dropdown.kind === 'file' ? dropdown.items.length : height}
    />
  );
}
