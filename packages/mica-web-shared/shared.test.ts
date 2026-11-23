import { describe, expect, it } from 'vitest';
import { toolIcon, toolLabel } from './index.js';

describe('mica-web-shared tools', () => {
  // 图标由宿主投影提供（工具自己声明的 emoji），共享层只负责查表与兜底。
  const icons: Record<string, string> = { run_shell: '⚡️', read_file: '📖' };

  it('maps builtin tools to stable icons and labels', () => {
    expect(toolIcon('run_shell', icons)).toBe('⚡️');
    expect(toolIcon('read_file', icons)).toBe('📖');
    expect(toolIcon('unknown_tool', icons)).toBe('⚙️');
    expect(toolIcon(null, icons)).toBe('⚙️');
    expect(toolLabel('run_shell')).toBe('Shell');
    expect(toolLabel('grep_search')).toBe('Search code');
    expect(toolLabel('unknown_tool')).toBe('unknown_tool');
  });

  it('renders MCP tools with server prefix and stripped hash', () => {
    expect(toolIcon('mcp__server__tool_ab12cd34', icons)).toBe('🔌');
    expect(toolLabel('mcp__server__tool_ab12cd34')).toBe('[MCP:server] tool');
    expect(toolLabel('mcp__server__tool')).toBe('[MCP:server] tool');
  });
});
