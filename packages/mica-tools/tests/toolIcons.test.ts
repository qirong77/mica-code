import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getToolCatalog,
  getToolIcon,
  getToolIcons,
  publishToolIcons,
  registerRuntimeTool,
  unregisterRuntimeTool,
} from '../registry.js';
import { readToolIconCatalog, resetToolIconCatalogCache, writeToolIconCatalog } from '../toolIconCatalog.js';

/** 目录里的真实工具（静态兜底占位项没有 inputSchema，不算）。 */
function registeredTools() {
  return getToolCatalog().filter((tool) => tool.inputSchema);
}

function demoPluginTool(icon: string) {
  return registerRuntimeTool(
    {
      name: 'demo_plugin_tool',
      description: '',
      input_schema: { type: 'object', properties: {} },
      execute: async () => '',
    },
    { icon },
  );
}

describe('工具行 emoji', () => {
  it('每个内置工具都声明了自己的图标', () => {
    const builtin = registeredTools().filter((tool) => tool.source === 'builtin');
    expect(builtin.length).toBeGreaterThan(10);
    // 缺一个就是齿轮：这条测试就是「新增工具时别忘了一起加 icon」的那道关。
    const missing = builtin.filter((tool) => !tool.icon || tool.icon === '⚙️').map((tool) => tool.name);
    expect(missing).toEqual([]);
  });

  it('插件的图标来自注册选项', () => {
    const tool = demoPluginTool('🧪');
    try {
      expect(getToolIcon('demo_plugin_tool')).toBe('🧪');
      expect(getToolIcons().demo_plugin_tool).toBe('🧪');
    } finally {
      unregisterRuntimeTool(tool);
    }
    expect(getToolIcon('mcp__mica-browser__control')).toBe('🔌');
    expect(getToolIcon('not_a_tool')).toBe('⚙️');
  });

  it('把注册表投影成界面能读的文件，且内容不变时不重写', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mica-tool-icons-'));
    resetToolIconCatalogCache();
    publishToolIcons(dir);
    const tool = demoPluginTool('🧪');
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const icons = readToolIconCatalog(dir);
      expect(icons.demo_plugin_tool).toBe('🧪');
      expect(icons.read_file).toBe('📖');
      // MCP 工具不逐条投影：图标由 `mcp__` 前缀决定。
      expect(Object.keys(icons).some((name) => name.startsWith('mcp__'))).toBe(false);
      // 同一份内容再写一次没有意义。
      expect(writeToolIconCatalog(icons, dir)).toBe(false);
      expect(writeToolIconCatalog({ ...icons, run_shell: '💥' }, dir)).toBe(true);
      expect(readToolIconCatalog(dir).run_shell).toBe('💥');
    } finally {
      unregisterRuntimeTool(tool);
      publishToolIcons(null);
    }
  });
});
