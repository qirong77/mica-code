import { describe, expect, it } from 'vitest';
import type { MicaUiSubagentTaskItem } from '../types.js';
import { formatSubagentTaskAge, isActiveSubagentTaskStatus } from './SubagentTaskRow.js';

describe('SubagentTaskRow', () => {
  it('formats active task metadata for the compact status row', () => {
    const task: MicaUiSubagentTaskItem = {
      id: 'agent-task-1783932834549-7tr8ef',
      description: 'inspect task UI',
      subagentType: 'Explore',
      model: 'test-model',
      status: 'running',
      startedAt: new Date(1_000).toISOString(),
    };

    expect(isActiveSubagentTaskStatus(task.status)).toBe(true);
    expect(formatSubagentTaskAge(task, 3_500)).toBe('2.5s');
  });
});
