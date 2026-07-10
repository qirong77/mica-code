import { Box, useTerminalSize } from '@anthropic/ink';
import useStdin from '@packages/@anthropic/ink/src/hooks/use-stdin.js';
import { cursorPosition } from '@packages/@anthropic/ink/src/core/terminal-querier.js';
import { useEffect, useMemo, useState } from 'react';
import { useScheduleState } from '../../hooks/index.js';
import { useBottomPanelHeight } from '../../hooks/useLogViewHeight.js';
import { CommandDropdown } from './CommandDropdown.js';
import { state } from './state.js';

const ROWS_AFTER_INPUT_CURSOR = 3;

export function resolveDropdownHeight(rows: number, measuredHeight: number, cursorRow: number | null): number {
  if (cursorRow !== null) return Math.max(1, rows - cursorRow - ROWS_AFTER_INPUT_CURSOR);
  return Math.max(1, Math.min(measuredHeight, Math.floor(rows / 3)));
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
    const responsePromise = querier.send(cursorPosition());
    const flushPromise = querier.flush();
    void Promise.all([responsePromise, flushPromise]).then(([response]) => {
      if (!cancelled && response) setCursorRow(response.row);
    });

    return () => {
      cancelled = true;
    };
  }, [dropdown.visible, measuredHeight, querier, rows]);

  const height = resolveDropdownHeight(rows, measuredHeight, cursorRow);

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
        height={height}
      />
    </Box>
  );
}
