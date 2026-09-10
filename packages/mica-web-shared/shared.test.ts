import { describe, expect, it } from 'vitest';
import { toolIcon, toolLabel } from './index.js';

describe('mica-web-shared tools', () => {
  it('maps builtin tools to stable icons and labels', () => {
    expect(toolIcon('run_shell')).toBe('⚡️');
    expect(toolIcon('read_file')).toBe('📖');
    expect(toolIcon('unknown_tool')).toBe('⚙');
    expect(toolIcon(null)).toBe('⚙');
    expect(toolLabel('run_shell')).toBe('Shell');
    expect(toolLabel('grep_search')).toBe('Search code');
    expect(toolLabel('unknown_tool')).toBe('unknown_tool');
  });

  it('renders MCP tools with server prefix and stripped hash', () => {
    expect(toolIcon('mcp__server__tool_ab12cd34')).toBe('🔌');
    expect(toolLabel('mcp__server__tool_ab12cd34')).toBe('[MCP:server] tool');
    expect(toolLabel('mcp__server__tool')).toBe('[MCP:server] tool');
  });
});
