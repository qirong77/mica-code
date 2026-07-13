import { describe, expect, it } from 'vitest';
import type { MicaUiWorkingStatus } from '../types.js';
import { getTerminalTitle } from './TerminalTitle.js';

describe('getTerminalTitle', () => {
  it.each([
    { type: 'connecting' },
    { type: 'thinking' },
    { type: 'streaming' },
    { type: 'calling_tool' },
    { type: 'plugin_task', text: 'working' },
  ] satisfies MicaUiWorkingStatus[])('shows the running animation for $type', (status) => {
    expect(getTerminalTitle(status, 0)).toBe('◦ Mica');
    expect(getTerminalTitle(status, 1)).toBe('○ Mica');
    expect(getTerminalTitle(status, 2)).toBe('◉ Mica');
    expect(getTerminalTitle(status, 3)).toBe('○ Mica');
    expect(getTerminalTitle(status, 4)).toBe('◦ Mica');
  });

  it('shows the finished title after successful completion', () => {
    expect(getTerminalTitle({ type: 'completed' })).toBe('✓ Mica');
  });

  it('shows the app title while idle', () => {
    expect(getTerminalTitle({ type: 'idle' })).toBe('Mica');
  });

  it('shows the error title after a failed turn', () => {
    expect(getTerminalTitle({ type: 'error', message: 'failed' })).toBe('✕ Mica');
  });
});
