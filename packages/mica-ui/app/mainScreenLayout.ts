const MAIN_SCREEN_RESERVED_ROWS = 1;

/**
 * Keep the main-screen frame strictly shorter than the terminal viewport.
 *
 * Ink parks its logical cursor immediately after a main-screen frame. If the
 * frame fills every terminal row, that cursor position is below the viewport
 * and the next render scrolls the terminal before applying its diff.
 */
export function getMainScreenHeight(rows: number): number {
  const normalizedRows = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24;
  return Math.max(0, normalizedRows - MAIN_SCREEN_RESERVED_ROWS);
}
