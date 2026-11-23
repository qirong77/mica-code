import { describe, expect, it } from 'vitest';
import { toolIcon, toolLabel } from './tools.js';

describe('tool display vocabulary', () => {
  // 图标不再有静态表：它由宿主给的投影（已注册工具自己声明的 emoji）决定，这里只是查表。
  const icons: Record<string, string> = { run_shell: '⚡️', read_file: '📖', skill: '✨' };

  it('looks icons up in the host projection', () => {
    expect(toolIcon('run_shell', icons)).toBe('⚡️');
    expect(toolIcon('read_file', icons)).toBe('📖');
  });

  it('resolves legacy names to the current tool', () => {
    expect(toolIcon('Skill', icons)).toBe('✨');
    expect(toolIcon('Skill', icons)).toBe(toolIcon('skill', icons));
  });

  it('falls back to the default gear when the projection has no entry', () => {
    expect(toolIcon('unknown_tool', icons)).toBe('⚙️');
    expect(toolIcon('unknown_tool')).toBe('⚙️');
    expect(toolIcon(null, icons)).toBe('⚙️');
  });

  it('labels renamed tools by their current name', () => {
    expect(toolLabel('skill')).toBe('Load skill');
    expect(toolLabel('agent')).toBe('Subagent');
    expect(toolLabel('todo_write')).toBe('Plan');
    expect(toolLabel('session_notes')).toBe('Session notes');
  });

  it('still resolves labels for legacy tool names in old conversations', () => {
    expect(toolLabel('Skill')).toBe('Load skill');
    expect(toolLabel('Agent')).toBe('Subagent');
    expect(toolLabel('TodoWrite')).toBe('Plan');
    expect(toolLabel('SessionNotes')).toBe('Session notes');
  });

  it('falls back to the raw name for unknown tools', () => {
    expect(toolLabel('some_new_tool')).toBe('some_new_tool');
  });

  it('renders MCP tools with the server prefix', () => {
    expect(toolLabel('mcp__mica-browser__control_4e54cce9')).toBe('[MCP:mica-browser] control');
    expect(toolIcon('mcp__mica-browser__control', icons)).toBe('🔌');
  });
});
