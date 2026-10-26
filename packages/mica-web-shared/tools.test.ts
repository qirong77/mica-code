import { describe, expect, it } from 'vitest';
import { toolIcon, toolLabel } from './tools.js';

describe('tool display vocabulary', () => {
  it('labels renamed tools by their current name', () => {
    expect(toolLabel('skill')).toBe('Load skill');
    expect(toolLabel('agent')).toBe('Subagent');
    expect(toolLabel('todo_write')).toBe('Plan');
    expect(toolLabel('session_notes')).toBe('Session notes');
  });

  it('still resolves icons and labels for legacy tool names in old conversations', () => {
    expect(toolLabel('Skill')).toBe('Load skill');
    expect(toolLabel('Agent')).toBe('Subagent');
    expect(toolLabel('TodoWrite')).toBe('Plan');
    expect(toolLabel('SessionNotes')).toBe('Session notes');
    expect(toolIcon('Skill')).toBe(toolIcon('skill'));
  });

  it('falls back to the raw name for unknown tools', () => {
    expect(toolLabel('some_new_tool')).toBe('some_new_tool');
    expect(toolIcon('some_new_tool')).toBe('⚙');
  });

  it('renders MCP tools with the server prefix', () => {
    expect(toolLabel('mcp__mica-browser__control_4e54cce9')).toBe('[MCP:mica-browser] control');
    expect(toolIcon('mcp__mica-browser__control')).toBe('🔌');
  });
});
