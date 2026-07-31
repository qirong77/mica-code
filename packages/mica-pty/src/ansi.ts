/**
 * ANSI escape sequence stripping for captured PTY output.
 *
 * Keeps `\t`, `\r` and `\n` (they are meaningful for TUI layout) while removing
 * CSI/OSC sequences, charset-select escapes and bare control bytes. Mirrors the
 * behaviour of the original python driver in `temp/mica_pty.py`.
 */

const ANSI_RE = new RegExp(
  [
    String.raw`\x1b\[[0-9;?]*[a-zA-Z]`, // CSI (cursor movement, erase, SGR, ...)
    String.raw`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`, // OSC (title, hyperlink, ...)
    String.raw`\x1b[()][0-9A-B]`, // charset select
    String.raw`\x1b[@-Z\\-~]`, // other ESC sequences
    String.raw`[\x00-\x08\x0b\x0c\x0e-\x1f]`, // control bytes except \t \r \n
  ].join('|'),
  'g',
);

/** Strip ANSI/control sequences from captured terminal output. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** Regex used to strip raw PTY output. */
export const ANSI_STRIP_RE = ANSI_RE;
