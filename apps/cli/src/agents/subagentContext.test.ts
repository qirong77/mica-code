import { describe, expect, it } from 'vitest';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { buildDelegatedSubagentPrompt, resolveSubagentContextMode } from './subagentContext.js';
import { getSubagent } from './subagentDefinitions.js';

describe('subagentContext', () => {
  it('defaults context mode from the subagent definition', () => {
    expect(resolveSubagentContextMode(undefined, getSubagent('Explore'))).toBe('brief');
    expect(resolveSubagentContextMode(undefined, getSubagent('Implementer'))).toBe('files');
  });

  it('wraps the task with a delegated context brief from parent history', () => {
    const parentAgent = {
      getSnapshot: () => ({
        messages: [
          { role: 'user', content: 'Please inspect the config loader.' },
          { role: 'assistant', content: 'I will look at packages/mica-config next.' },
        ],
      }),
    } as unknown as AgentRuntime;

    const prompt = buildDelegatedSubagentPrompt({
      prompt: 'Summarize the loader.',
      contextMode: 'brief',
      parentAgent,
    });

    expect(prompt).toContain('<delegated-context>');
    expect(prompt).toContain('Please inspect the config loader.');
    expect(prompt).toContain('<task>');
    expect(prompt).toContain('Summarize the loader.');
  });

  it('keeps the raw task when context mode is none', () => {
    const parentAgent = {
      getSnapshot: () => ({ messages: [{ role: 'user', content: 'history' }] }),
    } as unknown as AgentRuntime;

    expect(
      buildDelegatedSubagentPrompt({
        prompt: 'Do only this.',
        contextMode: 'none',
        parentAgent,
      }),
    ).toBe('Do only this.');
  });
});
