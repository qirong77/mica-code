import { describe, expect, it } from 'vitest';
import type { MicaUiSubagentTaskItem } from '../types.js';
import { hasRunningSubagent, shouldIgnoreTerminalTextInput } from './TerminalInput.js';

describe('TerminalInput interruptible work', () => {
  it('treats a running subagent as interruptible after the parent turn is idle', () => {
    expect(hasRunningSubagent([subagentTask('running')])).toBe(true);
    expect(hasRunningSubagent([subagentTask('completed')])).toBe(false);
    expect(hasRunningSubagent([])).toBe(false);
  });
});

describe('TerminalInput multiline input', () => {
  it('keeps Shift+Enter available for a newline while a dropdown is open', () => {
    expect(shouldIgnoreTerminalTextInput({ return: true, shift: true }, true, false)).toBe(false);
  });

  it('keeps plain Enter reserved for an open dropdown', () => {
    expect(shouldIgnoreTerminalTextInput({ return: true, shift: false }, true, false)).toBe(true);
  });

  it('leaves Shift+Enter owned by an interactive input plugin', () => {
    expect(shouldIgnoreTerminalTextInput({ return: true, shift: true }, false, true)).toBe(true);
  });
});

function subagentTask(status: MicaUiSubagentTaskItem['status']): MicaUiSubagentTaskItem {
  return {
    id: 'task-1',
    description: 'background work',
    subagentType: 'Explore',
    model: 'test-model',
    status,
    activities: [],
    startedAt: new Date(0).toISOString(),
  };
}
