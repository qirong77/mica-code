export function moveSelection(current: number, length: number, direction: -1 | 1): number {
  if (length <= 0) return 0;
  return (current + direction + length) % length;
}

export function selectionDirection(key: { upArrow?: boolean; downArrow?: boolean }): -1 | 1 | null {
  if (key.upArrow) return -1;
  if (key.downArrow) return 1;
  return null;
}
