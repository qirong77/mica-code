import { expect, it } from 'vitest';
import { micaTools } from '@packages/mica-tools/index.js';
import { getToolIcon } from './agentTurnLogItems.js';

it('reads the tool emoji from the registry, not from a table of its own', () => {
  // 内置工具的图标写在工具类里（`MicaTool.icon`），终端与注册表同进程，直接查。
  expect(getToolIcon('read_file')).toBe('📖');
  expect(getToolIcon('run_shell')).toBe('⚡️');
  // 改名前留下的历史名字仍要画对
  expect(getToolIcon('Skill')).toBe('✨');
  expect(getToolIcon('mcp__mica-browser__control')).toBe('🔌');
  expect(getToolIcon('not_a_tool')).toBe('⚙️');
});

it('shows the emoji a plugin declared when it registered the tool', () => {
  const tool = micaTools.registerRuntime(
    {
      name: 'demo_plugin_tool',
      description: '',
      input_schema: { type: 'object', properties: {} },
      execute: async () => '',
    },
    { icon: '🧪' },
  );
  try {
    expect(getToolIcon('demo_plugin_tool')).toBe('🧪');
  } finally {
    micaTools.unregisterRuntime(tool);
  }
});
