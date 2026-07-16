import { describe, expect, it } from 'vitest';
import type { MicaUiSubagentTaskItem } from '../types.js';
import { buildSubagentTaskForest, formatSubagentTaskAge, isActiveSubagentTaskStatus } from './SubagentTaskRow.js';

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

  it('builds a nested forest from parentTaskId', () => {
    const parent: MicaUiSubagentTaskItem = {
      id: 'parent',
      description: 'parent task',
      subagentType: 'Implementer',
      model: 'test-model',
      status: 'running',
      startedAt: new Date(1_000).toISOString(),
      activities: [{ id: 'a1', summary: 'reading a.ts', toolName: 'read_file', startedAt: new Date(1_500).toISOString() }],
    };
    const child: MicaUiSubagentTaskItem = {
      id: 'child',
      description: 'child task',
      subagentType: 'Explore',
      model: 'test-model',
      status: 'running',
      parentTaskId: 'parent',
      startedAt: new Date(2_000).toISOString(),
    };
    const orphan: MicaUiSubagentTaskItem = {
      id: 'orphan',
      description: 'missing parent',
      subagentType: 'Explore',
      model: 'test-model',
      status: 'running',
      parentTaskId: 'missing',
      startedAt: new Date(3_000).toISOString(),
    };

    const forest = buildSubagentTaskForest([child, orphan, parent]);
    expect(forest.roots.map((task) => task.id)).toEqual(['parent', 'orphan']);
    expect(forest.childrenByParent.get('parent')?.map((task) => task.id)).toEqual(['child']);
  });
});
