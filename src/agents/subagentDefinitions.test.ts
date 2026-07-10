import { describe, expect, it } from 'vitest';
import { buildSubagentSystemPrompt, getSubagent } from './subagentDefinitions.js';

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
});
