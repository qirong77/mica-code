import { describe, expect, it, vi } from 'vitest';
import type { ModelClientOptions } from '@packages/mica-agent/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { ToolAgent } from './ToolAgent.js';

describe('ToolAgent', () => {
  it('runs a synchronous child agent with the selected subagent tool filter', async () => {
    const { runtime, createSubAgent, query } = createRuntimeStub();
    const tool = new ToolAgent(runtime);

    const result = await tool.execute({
      description: 'inspect files',
      subagent_type: 'Explore',
      prompt: 'Find the config loader.',
    });

    expect(query).toHaveBeenCalledWith('Find the config loader.', { signal: undefined });
    expect(result).toContain('Subagent: Explore');
    expect(result).toContain('child result');

    const options = createSubAgent.mock.calls[0]?.[0] as ModelClientOptions;
    expect(options.tools).toBe(true);
    expect(options.effort).toBe('none');
    expect(options.toolFilter?.('read_file')).toBe(true);
    expect(options.toolFilter?.('write_file')).toBe(false);
    expect(options.toolFilter?.('Agent')).toBe(false);
  });

  it('blocks nested Agent calls for the general-purpose subagent', async () => {
    const { runtime, createSubAgent } = createRuntimeStub();
    const tool = new ToolAgent(runtime);

    await tool.execute({
      description: 'general task',
      prompt: 'Do the task.',
    });

    const options = createSubAgent.mock.calls[0]?.[0] as ModelClientOptions;
    expect(options.toolFilter?.('read_file')).toBe(true);
    expect(options.toolFilter?.('Agent')).toBe(false);
    expect(options.toolFilter?.('Task')).toBe(false);
  });
});

function createRuntimeStub() {
  const query = vi.fn(async () => 'child result');
  const createSubAgent = vi.fn((_: ModelClientOptions) => ({ query }));
  const createClientOptions = vi.fn((overrides: Partial<ModelClientOptions> = {}) => ({
    model: 'parent-model',
    ...overrides,
  }));
  const runtime = {
    createSubAgent,
    createClientOptions,
  } as unknown as AgentRuntime;
  return { runtime, createSubAgent, createClientOptions, query };
}
