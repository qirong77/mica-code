import { describe, expect, it } from 'vitest';
import type { MicaUiSubagentTaskItem } from '../types.js';
import { hasRunningSubagent } from './TerminalInput.js';

describe('TerminalInput interruptible work', () => {
  it('treats a running subagent as interruptible after the parent turn is idle', () => {
    expect(hasRunningSubagent([subagentTask('running')])).toBe(true);
    expect(hasRunningSubagent([subagentTask('completed')])).toBe(false);
    expect(hasRunningSubagent([])).toBe(false);
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
