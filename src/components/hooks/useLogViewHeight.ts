import { useTerminalSize } from '@anthropic/ink';
import { useScheduleState } from './useScheduleState';
import { inputBottomDistanceAtom } from '../../store';

export function useLogViewHeight() {
  const { columns, rows } = useTerminalSize();
  const bottomDistance = useScheduleState(inputBottomDistanceAtom);
  const RESERVED_LINES = 2;
  const viewportHeight = Math.max(
    5,
    (bottomDistance as number) - RESERVED_LINES,
    Math.ceil(rows / 2),
  );
  return viewportHeight;
}
