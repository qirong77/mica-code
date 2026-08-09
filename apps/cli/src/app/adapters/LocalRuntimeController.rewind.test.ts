import { describe, expect, it } from 'vitest';
import type { AgentRuntime, AgentRuntimeSnapshot } from '../../agent/AgentRuntime.js';
import { LocalRuntimeController } from './LocalRuntimeController.js';

describe('LocalRuntimeController rewind history', () => {
  it('lazily rebuilds conversation-only nodes when in-memory checkpoints are missing', () => {
    const snapshot: AgentRuntimeSnapshot = {
      providerId: 'openai',
      protocol: 'openai_chat_completions',
      model: 'test-model',
      effort: 'none',
      role: 'default',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'second answer' },
      ],
      usageHistory: [],
      lastUsage: undefined,
    };
    const agent = {
      getSnapshot: () => snapshot,
      toConversationMessages: () => [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'second answer' },
      ],
    } as unknown as AgentRuntime;
    const controller = new LocalRuntimeController(agent, {} as never, {} as never, {} as never, {} as never);

    const checkpoints = controller.listRewindCheckpoints();

    expect(checkpoints.map((checkpoint) => checkpoint.conversationLabel)).toEqual(['first', 'second']);
    expect(controller.getRewindPreview(checkpoints[0]!.id)).toMatchObject({
      ok: true,
      fileStateAvailable: false,
      files: [],
    });
  });
});
