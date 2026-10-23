import { describe, expect, it } from 'vitest';
import { getToolCatalog } from '../registry.js';

describe('tool catalog', () => {
  it('groups the pty family under one key', () => {
    const catalog = getToolCatalog();
    const pty = catalog.filter((tool) => tool.name.startsWith('pty_'));
    expect(pty).toHaveLength(5);
    expect(new Set(pty.map((tool) => tool.group.key))).toEqual(new Set(['pty']));
    expect(new Set(pty.map((tool) => tool.group.label))).toEqual(new Set(['交互终端']));
  });

  it('keeps tools without a shared prefix in their named group', () => {
    const byName = new Map(getToolCatalog().map((tool) => [tool.name, tool]));
    expect(byName.get('run_shell')?.group.key).toBe('shell');
    expect(byName.get('kill_task')?.group.key).toBe('shell');
    expect(byName.get('apply_patch')?.group.key).toBe('edit');
    expect(byName.get('read_file')?.group.key).toBe('file');
    expect(byName.get('web_search')?.group.key).toBe('web');
  });

  it('summarises input parameters for the detail panel', () => {
    const applyPatch = getToolCatalog().find((tool) => tool.name === 'apply_patch');
    expect(applyPatch?.parameters).toEqual([
      {
        name: 'patch',
        type: 'string',
        required: true,
        description: '补丁文本，必须以 *** Begin Patch 开始，以 *** End Patch 结束。',
      },
    ]);
  });
});
