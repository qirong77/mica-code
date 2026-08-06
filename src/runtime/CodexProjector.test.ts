import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { attachCodexProjector } from './CodexProjector.js';

type RuntimeEventMap = {
  text: [text: string];
  thinking: [text: string];
  toolCall: [call: { name: string; args: string; id: string }];
  toolResult: [result: { name: string; result: string; id: string }];
  usage: [record: { totalTokens?: number; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }];
};

function fakeAgent(): {
  events: EventEmitter;
  emit: <K extends keyof RuntimeEventMap>(event: K, ...args: RuntimeEventMap[K]) => void;
} {
  const events = new EventEmitter();
  return {
    events,
    emit: (event, ...args) => {
      events.emit(event, ...(args as unknown[]));
    },
  };
}

function collect() {
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    notifications,
    writer: (method: string, params: unknown) =>
      notifications.push({ method, params: params as Record<string, unknown> }),
  };
}

describe('attachCodexProjector thinking', () => {
  it('emits reasoning deltas when thinking is enabled', () => {
    const agent = fakeAgent();
    const { notifications, writer } = collect();
    const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
      threadId: 't',
      turnId: 'turn-1',
      cwd: '/tmp',
      thinking: true,
    });
    agent.emit('thinking', 'let me think');
    projector.dispose();
    const reasoning = notifications.filter((n) => n.method === 'item/reasoning/textDelta');
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]!.params.delta).toBe('let me think');
  });

  it('suppresses reasoning deltas by default', () => {
    const agent = fakeAgent();
    const { notifications, writer } = collect();
    const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
      threadId: 't',
      turnId: 'turn-1',
      cwd: '/tmp',
    });
    agent.emit('thinking', 'let me think');
    projector.dispose();
    const reasoning = notifications.filter((n) => n.method === 'item/reasoning/textDelta');
    expect(reasoning).toHaveLength(0);
  });

  it('emits cumulative usage total with each usage record', () => {
    const agent = fakeAgent();
    const { notifications, writer } = collect();
    const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
      threadId: 't',
      turnId: 'turn-1',
      cwd: '/tmp',
    });
    agent.emit('usage', { totalTokens: 10, inputTokens: 4, outputTokens: 6 });
    agent.emit('usage', { totalTokens: 25, inputTokens: 10, outputTokens: 15 });
    projector.dispose();
    const usage = notifications.filter((n) => n.method === 'thread/tokenUsage/updated');
    expect(usage).toHaveLength(2);
    expect((usage[0]!.params.tokenUsage as { total: { total_tokens: number } }).total.total_tokens).toBe(10);
    expect((usage[1]!.params.tokenUsage as { total: { total_tokens: number } }).total.total_tokens).toBe(35);
  });

  it('carries Mica displayText on commandExecution items', () => {
    const agent = fakeAgent();
    const { notifications, writer } = collect();
    const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
      threadId: 't',
      turnId: 'turn-1',
      cwd: '/tmp',
    });
    agent.emit('toolCall', {
      name: 'read_file',
      args: JSON.stringify({ file_path: '/tmp/a.txt', offset: 10 }),
      id: 'c1',
    });
    agent.emit('toolResult', { name: 'read_file', result: 'content', id: 'c1' });
    projector.dispose();
    const started = notifications.find((n) => n.method === 'item/started');
    const completed = notifications.find((n) => n.method === 'item/completed');
    const startedItem = started!.params.item as { displayText?: string };
    const completedItem = completed!.params.item as { displayText?: string };
    expect(startedItem.displayText).toBe('read /tmp/a.txt :10');
    expect(completedItem.displayText).toBe('read /tmp/a.txt :10');
  });
});
