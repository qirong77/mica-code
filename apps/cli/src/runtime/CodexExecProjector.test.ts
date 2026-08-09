import { describe, expect, it } from 'vitest';
import mitt from 'mitt';
import type { CodexExecEvent } from '@packages/mica-runtime/index.js';
import type { AgentRuntime, AgentRuntimeEvents } from '../agent/AgentRuntime.js';
import { attachCodexExecProjector } from './CodexExecProjector.js';

function createAgent() {
  const events = mitt<AgentRuntimeEvents>();
  return { events } as unknown as AgentRuntime & { events: typeof events };
}

describe('attachCodexExecProjector', () => {
  it('projects turn lifecycle, agent text, reasoning and tool calls as ThreadEvent JSONL', () => {
    const agent = createAgent();
    const emitted: CodexExecEvent[] = [];
    const projector = attachCodexExecProjector(agent, { write: (event) => emitted.push(event) }, 'session-1', {
      thinking: true,
    });

    agent.events.emit('thinking', 'let me think');
    agent.events.emit('text', 'hello ');
    agent.events.emit('text', 'world');
    agent.events.emit('toolCall', { id: 't1', name: 'read_file', args: '{"path":"a.ts"}' });
    agent.events.emit('toolResult', { id: 't1', name: 'read_file', result: 'file contents' });
    agent.events.emit('usage', {
      provider: 'openai_responses',
      turnId: 1,
      requestIndex: 0,
      messageCount: 2,
      model: 'gpt',
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 5,
      totalTokens: 15,
      paidTokenRate: 1,
    });

    const text = projector.completeText('hello world');
    projector.dispose();

    expect(text).toBe('hello world');
    expect(emitted).toEqual([
      { type: 'thread.started', thread_id: 'session-1' },
      { type: 'turn.started' },
      { type: 'item.updated', item: { id: 'reasoning', type: 'reasoning', text: 'let me think' } },
      { type: 'item.updated', item: { id: 'agent-message', type: 'agent_message', text: 'hello ' } },
      { type: 'item.updated', item: { id: 'agent-message', type: 'agent_message', text: 'hello world' } },
      {
        type: 'item.started',
        item: {
          id: 't1',
          type: 'command_execution',
          command: 'read_file {"path":"a.ts"}',
          aggregated_output: '',
          exit_code: null,
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 't1',
          type: 'command_execution',
          command: 'read_file',
          aggregated_output: 'file contents',
          exit_code: 0,
          status: 'completed',
        },
      },
      {
        type: 'item.completed',
        item: { id: 'agent-message', type: 'agent_message', text: 'hello world' },
      },
    ]);

    expect(projector.getUsage()).toMatchObject({
      input_tokens: 6,
      cached_input_tokens: 4,
      output_tokens: 5,
    });
  });

  it('omits reasoning items when thinking is disabled', () => {
    const agent = createAgent();
    const emitted: CodexExecEvent[] = [];
    const projector = attachCodexExecProjector(agent, { write: (event) => emitted.push(event) }, 's', {});

    agent.events.emit('thinking', 'hidden');
    agent.events.emit('text', 'answer');
    projector.completeText('answer');
    projector.dispose();

    const types = emitted.map((event) => (event.type === 'item.updated' ? event.item.type : event.type));
    expect(types).not.toContain('reasoning');
    expect(types).toContain('agent_message');
  });
});
