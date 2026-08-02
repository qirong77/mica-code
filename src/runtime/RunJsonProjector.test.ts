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

    expect(written).toHaveLength(3);
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
          status: 'pending',
          input: { command: 'bun test' },
        },
      },
    });
    expect(written[2]).toMatchObject({
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
    expect(written).toHaveLength(3);
  });

  it('matches tool results without IDs to pending calls in FIFO order', () => {
    const agent = createFakeAgent();
    const written: RunJsonEvent[] = [];
    const projector = attachRunJsonProjector(
      agent,
      { write: (event: RunJsonEvent) => written.push(event) },
      'session-1',
    );

    agent.events.emit('toolCall', { name: 'read_file', args: '{"file_path":"first.ts"}' });
    agent.events.emit('toolCall', { name: 'read_file', args: '{"file_path":"second.ts"}' });
    agent.events.emit('toolResult', { name: 'read_file', result: 'first result' });
    agent.events.emit('toolResult', { name: 'read_file', result: 'second result' });

    const toolEvents = written.filter(
      (event): event is Extract<RunJsonEvent, { type: 'tool_use' }> => event.type === 'tool_use',
    );
    expect(toolEvents).toHaveLength(4);
    const firstCallID = toolEvents[0]!.part.callID;
    const secondCallID = toolEvents[1]!.part.callID;
    expect(firstCallID).not.toBe(secondCallID);
    expect(toolEvents[2]).toMatchObject({
      part: {
        callID: firstCallID,
        state: { status: 'completed', input: { file_path: 'first.ts' }, output: 'first result' },
      },
    });
    expect(toolEvents[3]).toMatchObject({
      part: {
        callID: secondCallID,
        state: { status: 'completed', input: { file_path: 'second.ts' }, output: 'second result' },
      },
    });
    projector.dispose();
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

  it('emits OpenCode-shaped reasoning records only when explicitly enabled', () => {
    const agent = createFakeAgent();
    const written: RunJsonEvent[] = [];
    const projector = attachRunJsonProjector(
      agent,
      { write: (event: RunJsonEvent) => written.push(event) },
      'session-1',
      { thinking: true },
    );

    agent.events.emit('thinking', 'checking the implementation');

    expect(written).toEqual([
      expect.objectContaining({
        type: 'reasoning',
        sessionID: 'session-1',
        part: { type: 'reasoning', text: 'checking the implementation' },
      }),
    ]);
    projector.dispose();
  });
});
