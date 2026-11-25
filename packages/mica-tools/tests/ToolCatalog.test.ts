import { describe, expect, it } from 'vitest';
import { MicaTool } from '../MicaTool.js';
import {
  getRegisteredToolSource,
  getToolCatalog,
  getToolDefinitions,
  registerMcpTools,
  registerRuntimeTool,
  unregisterMcpTools,
  unregisterRuntimeTool,
} from '../registry.js';

describe('tool catalog', () => {
  it('looks up registered tool sources without catalog fallbacks', () => {
    expect(getRegisteredToolSource('read_file')).toEqual({ source: 'builtin' });
    expect(getRegisteredToolSource('file')).toBeUndefined();
    expect(getRegisteredToolSource('not_registered')).toBeUndefined();
    const tool = registerRuntimeTool({
      name: 'source_lookup_test', description: '', input_schema: { type: 'object' }, execute: async () => '',
    });
    try {
      expect(getRegisteredToolSource('source_lookup_test')).toEqual({ source: 'builtin' });
    } finally {
      unregisterRuntimeTool(tool);
    }
    expect(getRegisteredToolSource('source_lookup_test')).toBeUndefined();
  });

  it('keeps the MCP source when the provider uses the short tool name', () => {
    class TestMcpTool extends MicaTool {
      constructor() {
        super('mcp__trusted__search', 'search', { type: 'object' }, { source: 'mcp', mcpServer: 'trusted' });
      }

      execute() {
        return Promise.resolve('ok');
      }

      onToolUseDisplayText() {
        return 'search';
      }
    }

    registerMcpTools([new TestMcpTool()]);
    try {
      expect(getRegisteredToolSource('search')).toEqual({ source: 'mcp', mcpServer: 'trusted' });
    } finally {
      unregisterMcpTools();
    }
  });

  it('does not register the removed PTY tools', () => {
    const catalog = getToolCatalog();
    const removedNames = ['pty_spawn', 'pty_send', 'pty_read', 'pty_wait', 'pty_kill'];
    expect(catalog.some((tool) => removedNames.includes(tool.name))).toBe(false);
    expect(getToolDefinitions().some((tool) => removedNames.includes(tool.name))).toBe(false);
  });

  it('leaves tools without a shared prefix ungrouped', () => {
    const byName = new Map(getToolCatalog().map((tool) => [tool.name, tool]));
    for (const name of ['run_shell', 'apply_patch', 'read_file', 'web_fetch', 'skill']) {
      expect(byName.get(name)?.group, name).toBeNull();
    }
  });

  it('groups the background task family by the shared prefix', () => {
    const byName = new Map(getToolCatalog().map((tool) => [tool.name, tool]));
    for (const name of [
      'background_tasks_start',
      'background_tasks_list',
      'background_tasks_read',
      'background_tasks_kill',
    ]) {
      expect(byName.get(name)?.group, name).toEqual({ key: 'background_tasks', label: '后台任务' });
    }
  });

  it('stays flat for prefixes that are not declared as a family', () => {
    // read_file / read_image 前缀相同但用途不同，不能自动成组
    const byName = new Map(getToolCatalog().map((tool) => [tool.name, tool]));
    expect(byName.get('read_file')?.group).toBeNull();
    expect(byName.get('read_image')?.group).toBeNull();
    expect(byName.get('web_fetch')?.group).toBeNull();
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
    // 插件在会话期注册的工具（agent / todo_write / session_peers）同样是产品内置能力，
    // 目录里不再区分「运行期」，否则面板要额外解释一类对用户没有意义的来源。
    expect(new Set(getToolCatalog().map((tool) => tool.source))).toEqual(new Set(['builtin']));
  });
});

it('groups registered plugin tools by owner regardless of their names', () => {
  const group = { key: 'plugin:example', label: 'Example' };
  const tools = ['subagent_drive', 'unrelated_action'].map((name) =>
    registerRuntimeTool(
      {
        name,
        description: '',
        input_schema: { type: 'object', properties: {} },
        execute: async () => '',
      },
      { group },
    ),
  );
  try {
    const catalog = getToolCatalog();
    for (const tool of tools) expect(catalog.find((entry) => entry.name === tool.name)?.group).toEqual(group);
  } finally {
    for (const tool of tools) unregisterRuntimeTool(tool);
  }
});
