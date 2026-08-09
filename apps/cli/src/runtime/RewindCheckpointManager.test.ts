import { describe, expect, it } from 'vitest';
import type { RuntimeInput } from '@packages/mica-runtime/index.js';
import type { AgentRuntime, AgentRuntimeSnapshot } from '../agent/AgentRuntime.js';
import { RewindCheckpointManager } from './RewindCheckpointManager.js';

describe('RewindCheckpointManager conversation fallback', () => {
  it('rebuilds resumed turns and keeps the selected turn including tool messages', () => {
    const manager = new RewindCheckpointManager();
    let currentSnapshot = makeSnapshot([
      { role: 'user', content: 'first request' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'first result' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second request' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'run_shell', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call-2', content: 'second result' },
      { role: 'assistant', content: 'second answer' },
    ]);
    const agent = makeAgent(
      () => currentSnapshot,
      (snapshot) => {
        currentSnapshot = snapshot;
      },
    );
    const conversationMessages = [
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second request', displayContent: 'second formatted request' },
      { role: 'assistant', content: 'second answer' },
    ];

    expect(manager.restoreConversationHistory(agent, conversationMessages)).toBe(2);
    const checkpoints = manager.list(agent);
    expect(checkpoints.map((checkpoint) => checkpoint.conversationLabel)).toEqual([
      'first request',
      'second formatted request',
    ]);

    const preview = manager.preview(agent, checkpoints[0]!.id);
    expect(preview).toMatchObject({ ok: true, fileStateAvailable: false, files: [] });
    if (!preview.ok) throw new Error(preview.message);
    const result = manager.apply(agent, {
      id: preview.id,
      mode: 'conversation_only',
      previewToken: preview.previewToken,
    });

    expect(result.inputText).toBe('first request');
    expect(result.messageCountRemoved).toBe(4);
    expect(currentSnapshot.messages).toEqual([
      { role: 'user', content: 'first request' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'first result' },
      { role: 'assistant', content: 'first answer' },
    ]);
    expect(result.conversationMessagesBefore).toEqual([
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'first answer' },
    ]);
    expect(manager.list(agent).map((checkpoint) => checkpoint.conversationLabel)).toEqual(['first request']);
  });

  it('restores old history before capturing the first new turn after resume', () => {
    const manager = new RewindCheckpointManager();
    let currentSnapshot = makeSnapshot([
      { role: 'user', content: 'resumed request' },
      { role: 'assistant', content: 'resumed answer' },
    ]);
    const agent = makeAgent(
      () => currentSnapshot,
      (snapshot) => {
        currentSnapshot = snapshot;
      },
    );

    manager.capture(agent, makeInput('new request'), [
      { role: 'user', content: 'resumed request' },
      { role: 'assistant', content: 'resumed answer' },
    ]);

    expect(manager.list(agent).map((checkpoint) => checkpoint.conversationLabel)).toEqual([
      'resumed request',
      'new request',
    ]);
  });

  it('only exposes visible user turns when provider history contains hidden inputs', () => {
    const manager = new RewindCheckpointManager();
    const snapshot = makeSnapshot([
      { role: 'user', content: 'first visible' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'hidden system continuation' },
      { role: 'assistant', content: 'hidden answer' },
      { role: 'user', content: 'second visible' },
      { role: 'assistant', content: 'second answer' },
    ]);
    const agent = makeAgent(
      () => snapshot,
      () => undefined,
    );

    manager.restoreConversationHistory(agent, [
      { role: 'user', content: 'first visible' },
      { role: 'assistant', content: 'first answer\n\nhidden answer' },
      { role: 'user', content: 'second visible' },
      { role: 'assistant', content: 'second answer' },
    ]);

    expect(manager.list(agent).map((checkpoint) => checkpoint.conversationLabel)).toEqual([
      'first visible',
      'second visible',
    ]);
  });

  it('does not expose compact metadata as a user-selectable turn', () => {
    const manager = new RewindCheckpointManager();
    const snapshot = makeSnapshot([
      { role: 'user', content: '[Mica compact boundary]\n\n{}' },
      { role: 'user', content: '[Mica compact checkpoint]\n\nsummary' },
      { role: 'user', content: 'recoverable request' },
      { role: 'assistant', content: 'answer' },
    ]);
    const agent = makeAgent(
      () => snapshot,
      () => undefined,
    );

    manager.restoreConversationHistory(agent);

    expect(manager.list(agent).map((checkpoint) => checkpoint.conversationLabel)).toEqual(['recoverable request']);
  });

  it('keeps a live checkpoint at the state after its selected turn', () => {
    const manager = new RewindCheckpointManager();
    let currentSnapshot = makeSnapshot([]);
    const agent = makeAgent(
      () => currentSnapshot,
      (snapshot) => {
        currentSnapshot = snapshot;
      },
    );
    const checkpointId = manager.capture(agent, makeInput('call a tool'))!;
    currentSnapshot = makeSnapshot([
      { role: 'user', content: 'call a tool' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'tool result' },
      { role: 'assistant', content: 'done' },
    ]);
    manager.finalize(agent, checkpointId, [
      { role: 'user', content: 'call a tool' },
      { role: 'assistant', content: 'done' },
    ]);

    const preview = manager.preview(agent, checkpointId);
    if (!preview.ok) throw new Error(preview.message);
    manager.apply(agent, {
      id: preview.id,
      mode: 'conversation_only',
      previewToken: preview.previewToken,
    });

    expect(currentSnapshot.messages).toEqual([
      { role: 'user', content: 'call a tool' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'tool result' },
      { role: 'assistant', content: 'done' },
    ]);
  });
});

function makeInput(text: string): RuntimeInput {
  return { id: `input-${text}`, text, source: 'ui', createdAt: Date.now() };
}

function makeSnapshot(messages: unknown[]): AgentRuntimeSnapshot {
  return {
    providerId: 'openai',
    protocol: 'openai_chat_completions',
    model: 'test-model',
    effort: 'none',
    role: 'default',
    messages,
    usageHistory: [],
    lastUsage: undefined,
  };
}

function makeAgent(
  getSnapshot: () => AgentRuntimeSnapshot,
  loadSnapshot: (snapshot: AgentRuntimeSnapshot) => void,
): AgentRuntime {
  return { getSnapshot, loadSnapshot } as unknown as AgentRuntime;
}
