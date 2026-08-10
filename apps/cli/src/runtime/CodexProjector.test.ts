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

  it('emits tool result as outputDelta then item/completed with aggregatedOutput', () => {
    const agent = fakeAgent();
    const { notifications, writer } = collect();
    const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
      threadId: 't',
      turnId: 'turn-1',
      cwd: '/tmp',
    });
    agent.emit('toolCall', { name: 'run_shell', args: JSON.stringify({ command: 'echo hi' }), id: 'c1' });
    agent.emit('toolResult', { name: 'run_shell', result: 'line1\nline2', id: 'c1' });
    projector.dispose();

    const delta = notifications.find((n) => n.method === 'item/commandExecution/outputDelta');
    const completed = notifications.find((n) => n.method === 'item/completed');
    expect(delta?.params.delta).toBe('line1\nline2');
    expect(delta?.params.itemId).toBe('c1');
    const completedItem = completed!.params.item as {
      aggregatedOutput?: string;
      status?: string;
      command?: string;
    };
    expect(completedItem.aggregatedOutput).toBe('line1\nline2');
    expect(completedItem.status).toBe('completed');
    // item/completed 的 command 只有工具名；完整命令（含参数）在 item/started 上。
    expect(completedItem.command).toBe('run_shell');
  });

  it('aggregates agent message deltas into item/completed', () => {
    const agent = fakeAgent();
    const { notifications, writer } = collect();
    const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
      threadId: 't',
      turnId: 'turn-message',
      cwd: '/tmp',
    });
    agent.emit('text', '第一段');
    agent.emit('text', '第二段');
    projector.completeTurn('completed');

    const completed = notifications.find(
      (notification) =>
        notification.method === 'item/completed' &&
        (notification.params.item as { type?: string } | undefined)?.type === 'agentMessage',
    );
    expect(completed?.params.item).toMatchObject({ type: 'agentMessage', text: '第一段第二段' });
  });

  it('truncates tool results over 256 KiB on the wire', () => {
    const agent = fakeAgent();
    const { notifications, writer } = collect();
    const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
      threadId: 't',
      turnId: 'turn-1',
      cwd: '/tmp',
    });
    const big = 'x'.repeat(300 * 1024);
    agent.emit('toolCall', { name: 'run_shell', args: '{}', id: 'c1' });
    agent.emit('toolResult', { name: 'run_shell', result: big, id: 'c1' });
    projector.dispose();

    const delta = notifications.find((n) => n.method === 'item/commandExecution/outputDelta');
    const completed = notifications.find((n) => n.method === 'item/completed');
    const completedItem = completed!.params.item as { aggregatedOutput?: string };
    expect(delta?.params.delta as string).toContain('...[truncated by Mica]');
    expect((delta?.params.delta as string).length).toBeLessThan(256 * 1024 + 64);
    expect(completedItem.aggregatedOutput).toBe(delta?.params.delta);
  });

  it('completes the turn with status/error mapping for completed, interrupted and failed', () => {
    const agent = fakeAgent();
    const { notifications, writer } = collect();
    const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
      threadId: 't',
      turnId: 'turn-1',
      cwd: '/tmp',
    });
    projector.completeTurn('completed');
    projector.dispose();

    const completed = notifications.filter((n) => n.method === 'turn/completed');
    expect(completed).toHaveLength(1);
    const turn = completed[0]!.params.turn as { status?: string; error?: { message?: string } | null };
    expect(turn.status).toBe('completed');
    expect(turn.error).toBeNull();

    const interruptedAgent = fakeAgent();
    const interrupted: Array<{ method: string; params: Record<string, unknown> }> = [];
    const interruptedProjector = attachCodexProjector(
      interruptedAgent as unknown as AgentRuntime,
      (method, params) => interrupted.push({ method, params: params as Record<string, unknown> }),
      { threadId: 't', turnId: 'turn-2', cwd: '/tmp' },
    );
    interruptedProjector.completeTurn('interrupted');
    interruptedProjector.dispose();
    const interruptedTurn = interrupted
      .find((n) => n.method === 'turn/completed')!
      .params.turn as { status?: string };
    expect(interruptedTurn.status).toBe('interrupted');

    const failedAgent = fakeAgent();
    const failed: Array<{ method: string; params: Record<string, unknown> }> = [];
    const failedProjector = attachCodexProjector(
      failedAgent as unknown as AgentRuntime,
      (method, params) => failed.push({ method, params: params as Record<string, unknown> }),
      { threadId: 't', turnId: 'turn-3', cwd: '/tmp' },
    );
    failedProjector.completeTurn('failed', '400 bad model');
    failedProjector.dispose();
    const failedTurn = failed.find((n) => n.method === 'turn/completed')!.params.turn as {
      status?: string;
      error?: { message?: string } | null;
    };
    expect(failedTurn.status).toBe('failed');
    expect(failedTurn.error?.message).toBe('400 bad model');
  });
});
