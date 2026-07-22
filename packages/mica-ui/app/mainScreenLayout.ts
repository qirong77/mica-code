const MAIN_SCREEN_RESERVED_ROWS = 1;

/**
 * Keep a short main-screen frame strictly below the terminal viewport while
 * allowing long content to grow into the terminal's native scrollback.
 *
 * Ink parks its logical cursor immediately after a main-screen frame. If the
 * frame exactly fills every terminal row, that cursor position is below the
 * viewport and the next render scrolls the terminal before applying its diff.
 * App uses this value as a minimum height; fixing the height would make Yoga
 * shrink long conversations and let their text paint over later siblings.
 */
export function getMainScreenHeight(rows: number): number {
  const normalizedRows = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24;
  return Math.max(0, normalizedRows - MAIN_SCREEN_RESERVED_ROWS);
}
