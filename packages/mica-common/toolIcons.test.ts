import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_ICON, MCP_TOOL_ICON, toolIcon } from './toolIcons.js';

describe('toolIcon', () => {
  const declared: Record<string, string> = {
    read_file: '📖',
    skill: '✨',
    memory: '🧠',
  };
  const lookup = (name: string) => declared[name];

  it('uses the icon the tool itself declares', () => {
    expect(toolIcon('read_file', lookup)).toBe('📖');
    expect(toolIcon('memory', lookup)).toBe('🧠');
  });

  it('renders every MCP tool with the plug, whatever the server calls it', () => {
    expect(toolIcon('mcp__mica-browser__control_4e54cce9', lookup)).toBe(MCP_TOOL_ICON);
  });

  it('falls back to the default gear instead of an empty gap', () => {
    expect(toolIcon('some_new_tool', lookup)).toBe(DEFAULT_TOOL_ICON);
    expect(toolIcon('some_new_tool')).toBe(DEFAULT_TOOL_ICON);
    expect(toolIcon(null)).toBe(DEFAULT_TOOL_ICON);
    expect(toolIcon('   ')).toBe(DEFAULT_TOOL_ICON);
    // 声明成空白等于没声明
    expect(toolIcon('blank', () => '  ')).toBe(DEFAULT_TOOL_ICON);
  });
});
