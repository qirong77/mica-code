export function moveSelection(current: number, length: number, direction: -1 | 1): number {
  if (length <= 0) return 0;
  return (current + direction + length) % length;
}

export function selectionDirection(key: { upArrow?: boolean; downArrow?: boolean }): -1 | 1 | null {
  if (key.upArrow) return -1;
  if (key.downArrow) return 1;
  return null;
}

type ScrollHandle = {
  getViewportHeight(): number;
  scrollBy(offset: number): void;
};

type ScrollKey = {
  upArrow?: boolean;
  downArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
};

/** Route the standard vertical navigation keys to a scrollable command view. */
export function handleScrollInput(scroll: ScrollHandle | null, key: ScrollKey): boolean {
  if (!key.upArrow && !key.downArrow && !key.pageUp && !key.pageDown) return false;

  const pageSize = Math.max(1, (scroll?.getViewportHeight() ?? 10) - 1);
  if (key.upArrow) scroll?.scrollBy(-1);
  else if (key.downArrow) scroll?.scrollBy(1);
  else if (key.pageUp) scroll?.scrollBy(-pageSize);
  else scroll?.scrollBy(pageSize);
  return true;
}
