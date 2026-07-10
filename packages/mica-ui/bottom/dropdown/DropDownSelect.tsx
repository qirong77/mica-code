import { useTerminalSize } from '@anthropic/ink';
import useStdin from '@packages/@anthropic/ink/src/hooks/use-stdin.js';
import { cursorPosition } from '@packages/@anthropic/ink/src/core/terminal-querier.js';
import { useEffect, useState } from 'react';
import { useScheduleState } from '../../hooks/index.js';
import { useBottomPanelHeight } from '../../hooks/useLogViewHeight.js';
import { CommandDropdown } from './CommandDropdown.js';
import { state } from './state.js';

const ROWS_AFTER_INPUT_CURSOR = 3;

export function resolveDropdownHeight(rows: number, fallbackHeight: number, cursorRow: number | null): number {
  if (cursorRow !== null) return Math.max(1, rows - cursorRow - ROWS_AFTER_INPUT_CURSOR);
  return Math.max(1, Math.min(fallbackHeight, Math.floor(rows / 3)));
}

export function DropDownSelect() {
  const dropdown = useScheduleState(state);
  const measuredHeight = useBottomPanelHeight();
  const { rows } = useTerminalSize();
  const { internal_querier: querier } = useStdin();
  const [cursorRow, setCursorRow] = useState<number | null>(null);

  useEffect(() => {
    if (!dropdown.visible || !querier) {
      setCursorRow(null);
      return;
    }

    let cancelled = false;
    setCursorRow(null);
    void Promise.all([querier.send(cursorPosition()), querier.flush()]).then(([response]) => {
      if (!cancelled && response) setCursorRow(response.row);
    });

    return () => {
      cancelled = true;
    };
  }, [dropdown.visible, measuredHeight, querier, rows]);

  const height = resolveDropdownHeight(rows, measuredHeight, cursorRow);

  const selectedIndex = Math.min(dropdown.selectedIndex, Math.max(0, dropdown.items.length - 1));

  if (!dropdown.visible) return null;

  return (
    <CommandDropdown
      items={dropdown.items}
      selectedIndex={selectedIndex}
      title={dropdown.title}
      emptyMessage={dropdown.emptyMessage}
      height={height}
    />
  );
}
