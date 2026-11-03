import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { attachCodexProjector } from './CodexProjector.js';

type RuntimeEventMap = {
  textAttemptStart: [];
  textRollback: [];
  text: [text: string];
  thinking: [text: string];
  thinkingCheckpoint: [];
  thinkingRollback: [];
  thinkingReset: [];
  thinkingTurnAttemptStart: [];
  thinkingTurnAttemptRollback: [];
  toolCall: [call: { name: string; args: string; id: string }];
  toolResult: [result: { name: string; result: string; id: string }];
  usage: [record: { totalTokens?: number; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }];
};

function fakeAgent(): {
  events: EventEmitter;
  emit: <K extends keyof RuntimeEventMap>(event: K, ...args: RuntimeEventMap[K]) => void;
  registerTextRollbackConsumer: ReturnType<typeof vi.fn>;
  unregisterTextRollbackConsumer: ReturnType<typeof vi.fn>;
} {
  const events = new EventEmitter();
  const unregisterTextRollbackConsumer = vi.fn();
  return {
    events,
    registerTextRollbackConsumer: vi.fn(() => unregisterTextRollbackConsumer),
    unregisterTextRollbackConsumer,
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
  it('announces a thinking reset only to a client that supports thinking rollback', () => {
    for (const supported of [false, true]) {
      const agent = fakeAgent();
      const { notifications, writer } = collect();
      const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
        threadId: 't', turnId: 'turn-1', cwd: '/tmp', thinking: true, thinkingRollback: supported,
      });
      agent.emit('thinkingReset');
      expect(notifications.filter((entry) => entry.method === 'mica/reasoning/reset')).toHaveLength(supported ? 1 : 0);
      projector.dispose();
      expect(agent.events.listenerCount('thinkingReset')).toBe(0);
    }
  });
  it('undoes a whole run after a request retry without rolling anything back twice', () => {
    const agent = fakeAgent();
    const { notifications, writer } = collect();
    const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
      threadId: 't', turnId: 'turn-1', cwd: '/tmp', textRollback: true, thinkingRollback: true, thinking: true,
    });

    agent.emit('thinkingTurnAttemptStart');
    agent.emit('textAttemptStart');
    agent.emit('thinking', 'first');
    agent.emit('thinkingCheckpoint');
    agent.emit('text', 'first text');
    agent.emit('toolCall', { name: 'read_file', args: '{}', id: 'c1' });
    agent.emit('toolResult', { name: 'read_file', result: 'ok', id: 'c1' });
    agent.emit('textAttemptStart');
    agent.emit('thinking', 'partial');
    agent.emit('text', 'partial text');
    agent.emit('textRollback');
    agent.emit('textAttemptStart');
    agent.emit('thinking', 'second');
    agent.emit('thinkingCheckpoint');
    agent.emit('text', 'second text');
    agent.emit('thinkingTurnAttemptRollback');
    agent.emit('thinkingTurnAttemptStart');
    agent.emit('textAttemptStart');
    agent.emit('thinking', 'kept');
    agent.emit('thinkingCheckpoint');
    agent.emit('text', 'normal answer');
    projector.completeTurn('completed');

    expect(notifications.filter((n) => n.method === 'mica/reasoning/textRollback').map((n) => n.params))
      .toEqual([
        expect.objectContaining({ length: 7, micaAttemptId: 'turn-1:2' }),
        expect.objectContaining({ length: 6, micaAttemptId: 'turn-1:3' }),
        expect.objectContaining({ length: 5, micaAttemptId: 'turn-1:1' }),
      ]);
    expect(notifications.filter((n) => n.method === 'mica/agentMessage/textRollback').map((n) => n.params))
      .toEqual([
        expect.objectContaining({ length: 12, micaAttemptId: 'turn-1:2' }),
        expect.objectContaining({ length: 11, micaAttemptId: 'turn-1:3' }),
        expect.objectContaining({ length: 10, micaAttemptId: 'turn-1:1' }),
      ]);
    expect(notifications.findLast((n) => n.method === 'item/completed' && (n.params.item as { type: string }).type === 'agentMessage')?.params.item)
      .toMatchObject({ text: 'normal answer' });
    expect(notifications.find((n) => n.method === 'item/completed' && (n.params.item as { type: string }).type === 'commandExecution')?.params.item)
      .toMatchObject({ id: 'c1', aggregatedOutput: 'ok' });
    projector.dispose();
    expect(agent.events.listenerCount('thinkingTurnAttemptRollback')).toBe(0);
  });

  it('rolls back a run for text-only clients and preserves text before the run', () => {
    const agent = fakeAgent();
    const { notifications, writer } = collect();
    const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
      threadId: 't', turnId: 'turn-1', cwd: '/tmp', textRollback: true,
    });
    agent.emit('text', 'earlier ');
    agent.emit('thinkingTurnAttemptStart');
    agent.emit('textAttemptStart');
    agent.emit('text', 'discarded');
    agent.emit('thinkingTurnAttemptRollback');
    agent.emit('thinkingTurnAttemptStart');
    agent.emit('textAttemptStart');
    agent.emit('text', 'kept');
    projector.completeTurn('completed');
    expect(notifications.filter((n) => n.method === 'mica/agentMessage/textRollback').map((n) => n.params))
      .toEqual([expect.objectContaining({ length: 9, micaAttemptId: 'turn-1:1' })]);
    expect(notifications.findLast((n) => n.method === 'item/completed' && (n.params.item as { type: string }).type === 'agentMessage')?.params.item)
      .toMatchObject({ text: 'earlier kept' });
    projector.dispose();
  });

  it('rolls back only the failed attempt and keeps completed tool events', () => {
    const agent = fakeAgent();
    const { notifications, writer } = collect();
    const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
      threadId: 't', turnId: 'turn-1', cwd: '/tmp', textRollback: true,
    });
    expect(agent.registerTextRollbackConsumer).toHaveBeenCalledOnce();
    const consumer = agent.registerTextRollbackConsumer.mock.calls[0]![0] as {
      text: (...args: unknown[]) => void; start: () => void; rollback: () => void;
    };
    expect(agent.events.listeners('text')).toContain(consumer.text);
    expect(agent.events.listeners('textAttemptStart')).toContain(consumer.start);
    expect(agent.events.listeners('textRollback')).toContain(consumer.rollback);
    agent.emit('textAttemptStart');
    agent.emit('text', 'kept');
    agent.emit('toolCall', { name: 'read_file', args: '{}', id: 'c1' });
    agent.emit('toolResult', { name: 'read_file', result: 'ok', id: 'c1' });
    agent.emit('textAttemptStart');
    agent.emit('text', 'failed');
    agent.emit('textRollback');
    agent.emit('textAttemptStart');
    agent.emit('text', 'retry');
    projector.completeAgentMessage();
    expect(notifications.find((n) => n.method === 'mica/agentMessage/textRollback')?.params.length).toBe(6);
    const deltas = notifications.filter((n) => n.method === 'item/agentMessage/delta');
    expect(deltas.map((n) => n.params.micaAttemptId)).toEqual(['turn-1:1', 'turn-1:2', 'turn-1:3']);
    expect(notifications.find((n) => n.method === 'mica/agentMessage/textRollback')?.params.micaAttemptId).toBe('turn-1:2');
    expect(notifications.some((n) => n.method === 'item/completed' && (n.params.item as { type: string }).type === 'commandExecution')).toBe(true);
    expect(notifications.findLast((n) => n.method === 'item/completed' && (n.params.item as { type: string }).type === 'agentMessage')?.params.item).toMatchObject({ text: 'keptretry' });
    projector.dispose();
    projector.dispose();
    expect(agent.unregisterTextRollbackConsumer).toHaveBeenCalledOnce();
    expect(agent.events.listeners('text')).not.toContain(consumer.text);
    expect(agent.events.listeners('textAttemptStart')).not.toContain(consumer.start);
    expect(agent.events.listeners('textRollback')).not.toContain(consumer.rollback);
  });

  it('rolls back reasoning with the matching attempt identifier', () => {
    const agent = fakeAgent();
    const { notifications, writer } = collect();
    const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
      threadId: 't', turnId: 'turn-1', cwd: '/tmp', textRollback: true, thinkingRollback: true, thinking: true,
    });
    agent.emit('textAttemptStart');
    agent.emit('thinking', 'failed');
    agent.emit('textRollback');
    agent.emit('textAttemptStart');
    agent.emit('thinking', 'kept');
    expect(notifications.find((n) => n.method === 'mica/reasoning/textRollback')?.params).toMatchObject({ length: 6, micaAttemptId: 'turn-1:1' });
    expect(notifications.filter((n) => n.method === 'item/reasoning/textDelta').map((n) => n.params.micaAttemptId)).toEqual(['turn-1:1', 'turn-1:2']);
    projector.dispose();
  });

  it('keeps checkpointed reasoning, text and tool output when interrupted', () => {
    const agent = fakeAgent();
    const { notifications, writer } = collect();
    const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
      threadId: 't', turnId: 'turn-1', cwd: '/tmp', textRollback: true, thinkingRollback: true, thinking: true,
    });
    agent.emit('textAttemptStart');
    agent.emit('thinking', 'first');
    agent.emit('thinkingCheckpoint');
    agent.emit('thinking', ' second');
    agent.emit('thinkingCheckpoint');
    agent.emit('text', 'kept text');
    agent.emit('toolCall', { name: 'read_file', args: '{}', id: 'c1' });
    agent.emit('toolResult', { name: 'read_file', result: 'ok', id: 'c1' });
    agent.emit('textAttemptStart');
    agent.emit('thinking', 'unfinished');
    agent.emit('toolCall', { name: 'read_file', args: '{}', id: 'c2' });
    agent.emit('toolResult', { name: 'read_file', result: 'also ok', id: 'c2' });
    agent.emit('text', ' after');
    agent.emit('thinking', ' tail');
    agent.emit('thinkingRollback');
    agent.emit('thinkingRollback');
    projector.completeTurn('interrupted');

    expect(notifications.filter((n) => n.method === 'mica/reasoning/textRollback').map((n) => n.params))
      .toEqual([expect.objectContaining({ length: 15, micaAttemptId: 'turn-1:2' })]);
    expect(notifications.filter((n) => n.method === 'mica/agentMessage/textRollback')).toHaveLength(0);
    expect(notifications.findLast((n) => n.method === 'item/completed' && (n.params.item as { type: string }).type === 'agentMessage')?.params.item)
      .toMatchObject({ text: 'kept text after' });
    expect(notifications.filter((n) => n.method === 'item/completed' && (n.params.item as { type: string }).type === 'commandExecution').map((n) => n.params.item))
      .toEqual([
        expect.objectContaining({ id: 'c1', aggregatedOutput: 'ok' }),
        expect.objectContaining({ id: 'c2', aggregatedOutput: 'also ok' }),
      ]);
    projector.dispose();
    expect(agent.events.listenerCount('thinkingCheckpoint')).toBe(0);
    expect(agent.events.listenerCount('thinkingRollback')).toBe(0);
  });

  it('uses each original attempt ID when uncheckpointed reasoning spans requests', () => {
    const agent = fakeAgent();
    const { notifications, writer } = collect();
    const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
      threadId: 't', turnId: 'turn-1', cwd: '/tmp', thinkingRollback: true, thinking: true,
    });
    agent.emit('textAttemptStart');
    agent.emit('thinking', 'kept');
    agent.emit('thinkingCheckpoint');
    agent.emit('thinking', 'one');
    agent.emit('textAttemptStart');
    agent.emit('thinking', 'two!');
    agent.emit('thinkingRollback');
    expect(notifications.filter((n) => n.method === 'mica/reasoning/textRollback').map((n) => n.params))
      .toEqual([
        expect.objectContaining({ length: 4, micaAttemptId: 'turn-1:2' }),
        expect.objectContaining({ length: 3, micaAttemptId: 'turn-1:1' }),
      ]);
    expect(agent.registerTextRollbackConsumer).not.toHaveBeenCalled();
    projector.dispose();
  });

  it('undoes the whole failed attempt even when it contained a checkpoint', () => {
    const agent = fakeAgent();
    const { notifications, writer } = collect();
    const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
      threadId: 't', turnId: 'turn-1', cwd: '/tmp', textRollback: true, thinkingRollback: true, thinking: true,
    });
    agent.emit('textAttemptStart');
    agent.emit('thinking', 'previous');
    agent.emit('thinkingCheckpoint');
    agent.emit('textAttemptStart');
    agent.emit('thinking', 'checkpointed');
    agent.emit('thinkingCheckpoint');
    agent.emit('thinking', 'failed');
    agent.emit('text', 'failed text');
    agent.emit('textRollback');
    agent.emit('textAttemptStart');
    agent.emit('thinking', 'retry');
    agent.emit('thinkingRollback');
    agent.emit('textRollback');

    expect(notifications.filter((n) => n.method === 'mica/reasoning/textRollback').map((n) => n.params))
      .toEqual([
        expect.objectContaining({ length: 18, micaAttemptId: 'turn-1:2' }),
        expect.objectContaining({ length: 5, micaAttemptId: 'turn-1:3' }),
      ]);
    expect(notifications.filter((n) => n.method === 'mica/agentMessage/textRollback').map((n) => n.params))
      .toEqual([expect.objectContaining({ length: 11, micaAttemptId: 'turn-1:2' })]);
    projector.dispose();
  });

  it('restores the previous pending checkpoint state after a failed attempt', () => {
    const agent = fakeAgent();
    const { notifications, writer } = collect();
    const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
      threadId: 't', turnId: 'turn-1', cwd: '/tmp', textRollback: true, thinkingRollback: true, thinking: true,
    });
    agent.emit('textAttemptStart');
    agent.emit('thinking', 'earlier');
    agent.emit('textAttemptStart');
    agent.emit('thinking', 'failed');
    agent.emit('thinkingCheckpoint');
    agent.emit('textRollback');
    agent.emit('textAttemptStart');
    agent.emit('thinking', 'later');
    agent.emit('thinkingRollback');
    expect(notifications.filter((n) => n.method === 'mica/reasoning/textRollback').map((n) => n.params))
      .toEqual([
        expect.objectContaining({ length: 6, micaAttemptId: 'turn-1:2' }),
        expect.objectContaining({ length: 5, micaAttemptId: 'turn-1:3' }),
        expect.objectContaining({ length: 7, micaAttemptId: 'turn-1:1' }),
      ]);
    projector.dispose();
  });

  it('does not undo or restore the same pending reasoning twice when interruption precedes retry rollback', () => {
    const agent = fakeAgent();
    const { notifications, writer } = collect();
    const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
      threadId: 't', turnId: 'turn-1', cwd: '/tmp', textRollback: true, thinkingRollback: true, thinking: true,
    });
    agent.emit('textAttemptStart');
    agent.emit('thinking', 'earlier');
    agent.emit('textAttemptStart');
    agent.emit('thinking', 'later');
    agent.emit('thinkingRollback');
    agent.emit('textRollback');
    agent.emit('textAttemptStart');
    agent.emit('thinkingRollback');
    expect(notifications.filter((n) => n.method === 'mica/reasoning/textRollback').map((n) => n.params))
      .toEqual([
        expect.objectContaining({ length: 5, micaAttemptId: 'turn-1:2' }),
        expect.objectContaining({ length: 7, micaAttemptId: 'turn-1:1' }),
      ]);
    projector.dispose();
  });

  it('does not send a thinking rollback to a client without that capability', () => {
    const agent = fakeAgent();
    const { notifications, writer } = collect();
    const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
      threadId: 't', turnId: 'turn-1', cwd: '/tmp', thinking: true, textRollback: true,
    });
    agent.emit('textAttemptStart');
    agent.emit('thinking', 'reasoning');
    agent.emit('thinkingRollback');
    agent.emit('textRollback');
    expect(notifications.filter((n) => n.method === 'mica/reasoning/textRollback')).toHaveLength(0);
    projector.dispose();
  });

  it('does not subscribe to rollback events for older clients', () => {
    const agent = fakeAgent();
    const { writer } = collect();
    const projector = attachCodexProjector(agent as unknown as AgentRuntime, writer, {
      threadId: 't', turnId: 'turn-1', cwd: '/tmp',
    });
    expect(agent.events.listenerCount('textRollback')).toBe(0);
    expect(agent.registerTextRollbackConsumer).not.toHaveBeenCalled();
    projector.dispose();
  });
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
    // item/completed 与 item/started 的 command 形状一致（工具名 + JSON 参数），
    // 客户端据此还原 tool 名与入参；不要再从工具结果里反推展示文案。
    expect(completedItem.command).toBe('run_shell {"command":"echo hi"}');
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
