import { describe, expect, it } from 'vitest';
import { buildSubagentSystemPrompt, buildSubagentToolFilter, getSubagent } from './subagentDefinitions.js';

describe('subagent definitions', () => {
  it('rejects unknown subagent names instead of falling back', () => {
    expect(() => getSubagent('Explroe')).toThrow('Unknown subagent_type: Explroe');
  });

  it('includes runtime context and the selected role prompt', () => {
    const definition = getSubagent('Explore');
    const prompt = buildSubagentSystemPrompt(definition);

    expect(prompt).toContain('<subagent-instructions>');
    expect(prompt).toContain('<context>');
    expect(prompt).toContain(definition.systemPrompt);
  });

  it('allows read-only subagents to inspect image paths and URLs', () => {
    expect(buildSubagentToolFilter(getSubagent('Explore'))('read_image')).toBe(true);
    expect(buildSubagentToolFilter(getSubagent('Reviewer'))('read_image')).toBe(true);
  });

  it('lets every subagent inherit Skill and MCP tools', () => {
    const subagentTypes = ['general-purpose', 'Explore', 'Implementer', 'Reviewer', 'Tester', 'Planner', 'Proposal'];

    for (const subagentType of subagentTypes) {
      const filter = buildSubagentToolFilter(getSubagent(subagentType));
      expect(filter('Skill'), `${subagentType} should inherit Skill`).toBe(true);
      expect(filter('mcp__Cooper__readContent_07b6b9a6'), `${subagentType} should inherit MCP tools`).toBe(true);
    }
  });

  it('keeps the existing restrictions on non-inherited tools', () => {
    const filter = buildSubagentToolFilter(getSubagent('Explore'));

    expect(filter('write_file')).toBe(false);
    expect(filter('Agent')).toBe(false);
  });
});
