import mitt from 'mitt';
import { describe, expect, it } from 'vitest';
import type { RunJsonEvent } from '@packages/mica-runtime/index.js';
import type { AgentRuntime, AgentRuntimeEvents } from '../agent/AgentRuntime.js';
import { attachRunJsonProjector } from './RunJsonProjector.js';

function createFakeAgent() {
  const events = mitt<AgentRuntimeEvents>();
  return { events } as unknown as AgentRuntime & { events: ReturnType<typeof mitt<AgentRuntimeEvents>> };
}

describe('attachRunJsonProjector', () => {
  it('projects runtime events into the DevEco/OpenCode dialect consumed by Multica', () => {
    const agent = createFakeAgent();
    const written: RunJsonEvent[] = [];
    const projector = attachRunJsonProjector(
      agent,
      { write: (event: RunJsonEvent) => written.push(event) },
      'session-1',
    );

    agent.events.emit('text', 'hello');
    agent.events.emit('thinking', 'private plan');
    agent.events.emit('toolCall', { name: 'run_shell', args: '{"command":"bun test"}', id: 'call-1' });
    agent.events.emit('toolResult', { name: 'run_shell', result: 'ok', id: 'call-1' });
    agent.events.emit('usage', {
      provider: 'openai_responses',
      turnId: 1,
      requestIndex: 0,
      messageCount: 2,
      model: 'gpt',
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 3,
      totalTokens: 13,
      paidTokenRate: 1,
    });

    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({
      type: 'text',
      sessionID: 'session-1',
      part: { type: 'text', text: 'hello' },
    });
    expect(written[1]).toMatchObject({
      type: 'tool_use',
      sessionID: 'session-1',
      part: {
        type: 'tool',
        tool: 'run_shell',
        callID: 'call-1',
        state: {
          status: 'completed',
          input: { command: 'bun test' },
          output: 'ok',
        },
      },
    });
    expect(projector.getText()).toBe('hello');
    expect(projector.getUsage()).toEqual({ input: 6, output: 3, cacheRead: 4, cacheWrite: 0, total: 13 });

    projector.dispose();
    agent.events.emit('text', 'ignored');
    expect(written).toHaveLength(2);
  });

  it('publishes a provider final answer when no text delta was emitted', () => {
    const agent = createFakeAgent();
    const written: RunJsonEvent[] = [];
    const projector = attachRunJsonProjector(
      agent,
      { write: (event: RunJsonEvent) => written.push(event) },
      'session-1',
    );

    expect(projector.completeText('final answer')).toBe('final answer');
    expect(written[0]).toMatchObject({ type: 'text', part: { text: 'final answer' } });
  });
});
