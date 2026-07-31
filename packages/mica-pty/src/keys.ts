/** Key names mapped to the byte sequences sent to a PTY master. */

export type KeyName =
  | 'enter'
  | 'esc'
  | 'tab'
  | 'shiftTab'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageUp'
  | 'pageDown'
  | 'backspace'
  | 'delete'
  | 'ctrlC'
  | 'ctrlD'
  | 'ctrlL'
  | 'ctrlR'
  | 'ctrlU'
  | 'ctrlLeft'
  | 'ctrlRight'
  | 'altEnter';

export const KEYS: Record<KeyName, string> = {
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  shiftTab: '\x1b[Z',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  home: '\x1b[H',
  end: '\x1b[F',
  pageUp: '\x1b[5~',
  pageDown: '\x1b[6~',
  backspace: '\x7f',
  delete: '\x1b[3~',
  ctrlC: '\x03',
  ctrlD: '\x04',
  ctrlL: '\x0c',
  ctrlR: '\x12',
  ctrlU: '\x15',
  ctrlLeft: '\x1b[1;5D',
  ctrlRight: '\x1b[1;5C',
  altEnter: '\x1b\r',
};

/** Build a Ctrl+<letter> sequence, e.g. `ctrl('a')` -> `\x01`. */
export function ctrl(letter: string): string {
  const code = letter.toUpperCase().charCodeAt(0);
  if (code < 65 || code > 90) {
    throw new Error(`ctrl() expects a letter, got: ${letter}`);
  }
  return String.fromCharCode(code - 64);
}

/** Resolve a key name to its byte sequence; throws on unknown names. */
export function key(name: KeyName): string {
  return KEYS[name];
}
