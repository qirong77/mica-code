import { describe, expect, it } from 'vitest';
import { LEGACY_TOOL_NAMES, normalizeToolName } from './toolNames.js';
import { normalizeCapabilitySelection, setCapabilityEnabled, isCapabilityEnabled } from './capabilities.js';

describe('normalizeToolName', () => {
  it('maps legacy camel-case tool names onto their snake_case names', () => {
    expect(normalizeToolName('Skill')).toBe('skill');
    expect(normalizeToolName('Agent')).toBe('agent');
    expect(normalizeToolName('TodoWrite')).toBe('todo_write');
    expect(normalizeToolName('SessionNotes')).toBe('session_notes');
  });

  it('keeps names that never changed', () => {
    for (const name of ['read_file', 'run_shell', 'session_peers', 'pty_spawn', 'apply_patch']) {
      expect(normalizeToolName(name)).toBe(name);
    }
  });

  it('ignores MCP tool names and empty values', () => {
    expect(normalizeToolName('mcp__mica-browser__control_4e54cce9')).toBe('mcp__mica-browser__control_4e54cce9');
    expect(normalizeToolName('')).toBe('');
    expect(normalizeToolName(null)).toBe('');
    expect(normalizeToolName(undefined)).toBe('');
  });

  it('only registers the four renamed tools', () => {
    expect(Object.keys(LEGACY_TOOL_NAMES).sort()).toEqual(['Agent', 'SessionNotes', 'Skill', 'TodoWrite']);
  });
});

describe('capability selection tool-name migration', () => {
  it('treats a legacy disabled tool as the same tool after renaming', () => {
    const selection = normalizeCapabilitySelection({ disabledTools: ['Skill', 'TodoWrite'] });
    expect(selection.disabledTools).toEqual(['skill', 'todo_write']);
    expect(isCapabilityEnabled(selection, 'tools', 'skill')).toBe(false);
    expect(isCapabilityEnabled(selection, 'tools', 'todo_write')).toBe(false);
    expect(isCapabilityEnabled(selection, 'tools', 'agent')).toBe(true);
  });

  it('collapses a legacy name and its current name into one entry', () => {
    const selection = normalizeCapabilitySelection({ disabledTools: ['Skill', 'skill'] });
    expect(selection.disabledTools).toEqual(['skill']);
  });

  it('does not touch skill or MCP server names', () => {
    const selection = normalizeCapabilitySelection({
      disabledSkills: ['Skill'],
      disabledMcpServers: ['Agent'],
    });
    expect(selection.disabledSkills).toEqual(['Skill']);
    expect(selection.disabledMcpServers).toEqual(['Agent']);
  });

  it('writes the current name when toggling', () => {
    const selection = setCapabilityEnabled(normalizeCapabilitySelection({}), 'tools', 'agent', false);
    expect(selection.disabledTools).toEqual(['agent']);
  });
});
