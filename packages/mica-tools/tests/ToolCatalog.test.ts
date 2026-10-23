import { describe, expect, it } from 'vitest';
import { getToolCatalog } from '../registry.js';

describe('tool catalog', () => {
  it('groups the pty family under one key', () => {
    const catalog = getToolCatalog();
    const pty = catalog.filter((tool) => tool.name.startsWith('pty_'));
    expect(pty).toHaveLength(5);
    expect(new Set(pty.map((tool) => tool.group?.key))).toEqual(new Set(['pty']));
    expect(new Set(pty.map((tool) => tool.group?.label))).toEqual(new Set(['交互终端']));
  });

  it('leaves tools without a shared prefix ungrouped', () => {
    const byName = new Map(getToolCatalog().map((tool) => [tool.name, tool]));
    for (const name of ['run_shell', 'kill_task', 'apply_patch', 'read_file', 'web_search', 'Agent', 'Skill']) {
      expect(byName.get(name)?.group, name).toBeNull();
    }
  });

  it('stays flat for prefixes that are not declared as a family', () => {
    // read_file / read_image / read_task_output 前缀相同但用途不同，不能自动成组
    const byName = new Map(getToolCatalog().map((tool) => [tool.name, tool]));
    expect(byName.get('read_file')?.group).toBeNull();
    expect(byName.get('read_image')?.group).toBeNull();
    expect(byName.get('read_task_output')?.group).toBeNull();
    expect(byName.get('web_search')?.group).toBeNull();
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

  it('reports every non-MCP tool as builtin', () => {
    // 插件在会话期注册的工具（Agent / TodoWrite / session_peers）同样是产品内置能力，
    // 目录里不再区分「运行期」，否则面板要额外解释一类对用户没有意义的来源。
    expect(new Set(getToolCatalog().map((tool) => tool.source))).toEqual(new Set(['builtin']));
  });
});
