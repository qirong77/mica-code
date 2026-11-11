import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeInput } from '@packages/mica-runtime/index.js';
import type { AgentRuntime, AgentRuntimeSnapshot } from '../agent/AgentRuntime.js';
import { piAssistant, piToolResult, piUser } from '../session/piTestMessages.js';
import { RewindCheckpointManager } from './RewindCheckpointManager.js';

describe('RewindCheckpointManager conversation fallback', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  function makeManager(): RewindCheckpointManager {
    const dir = mkdtempSync(join(tmpdir(), 'rewind-test-'));
    tempDirs.push(dir);
    return new RewindCheckpointManager(dir);
  }

  it('rebuilds resumed turns and keeps the selected turn including tool messages', () => {
    const manager = makeManager();
    let currentSnapshot = makeSnapshot([
      piUser('first request'),
      piAssistant([{ type: 'toolCall', id: 'call-1', name: 'read_file', arguments: {} }], { stopReason: 'toolUse' }),
      piToolResult('call-1', 'read_file', 'first result'),
      piAssistant('first answer'),
      piUser('second request'),
      piAssistant([{ type: 'toolCall', id: 'call-2', name: 'run_shell', arguments: {} }], { stopReason: 'toolUse' }),
      piToolResult('call-2', 'run_shell', 'second result'),
      piAssistant('second answer'),
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
      piUser('first request'),
      piAssistant([{ type: 'toolCall', id: 'call-1', name: 'read_file', arguments: {} }], { stopReason: 'toolUse' }),
      piToolResult('call-1', 'read_file', 'first result'),
      piAssistant('first answer'),
    ]);
    expect(result.conversationMessagesBefore).toEqual([
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'first answer' },
    ]);
    expect(manager.list(agent).map((checkpoint) => checkpoint.conversationLabel)).toEqual(['first request']);
  });

  it('restores old history before capturing the first new turn after resume', async () => {
    const manager = makeManager();
    let currentSnapshot = makeSnapshot([
      piUser('resumed request'),
      piAssistant('resumed answer'),
    ]);
    const agent = makeAgent(
      () => currentSnapshot,
      (snapshot) => {
        currentSnapshot = snapshot;
      },
    );

    await manager.capture(agent, makeInput('new request'), [
      { role: 'user', content: 'resumed request' },
      { role: 'assistant', content: 'resumed answer' },
    ]);

    expect(manager.list(agent).map((checkpoint) => checkpoint.conversationLabel)).toEqual([
      'resumed request',
      'new request',
    ]);
  });

  it('only exposes visible user turns when provider history contains hidden inputs', () => {
    const manager = makeManager();
    const snapshot = makeSnapshot([
      piUser('first visible'),
      piAssistant('first answer'),
      piUser('hidden system continuation'),
      piAssistant('hidden answer'),
      piUser('second visible'),
      piAssistant('second answer'),
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
    const manager = makeManager();
    const snapshot = makeSnapshot([
      piUser('[Mica compact boundary]\n\n{}'),
      piUser('[Mica compact checkpoint]\n\nsummary'),
      piUser('recoverable request'),
      piAssistant('answer'),
    ]);
    const agent = makeAgent(
      () => snapshot,
      () => undefined,
    );

    manager.restoreConversationHistory(agent);

    expect(manager.list(agent).map((checkpoint) => checkpoint.conversationLabel)).toEqual(['recoverable request']);
  });

  it('keeps a live checkpoint at the state after its selected turn', async () => {
    const manager = makeManager();
    let currentSnapshot = makeSnapshot([]);
    const agent = makeAgent(
      () => currentSnapshot,
      (snapshot) => {
        currentSnapshot = snapshot;
      },
    );
    const checkpointId = (await manager.capture(agent, makeInput('call a tool')))!;
    currentSnapshot = makeSnapshot([
      piUser('call a tool'),
      piAssistant([{ type: 'toolCall', id: 'call-1', name: 'read_file', arguments: {} }], { stopReason: 'toolUse' }),
      piToolResult('call-1', 'read_file', 'tool result'),
      piAssistant('done'),
    ]);
    await manager.finalize(agent, checkpointId, [
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
      piUser('call a tool'),
      piAssistant([{ type: 'toolCall', id: 'call-1', name: 'read_file', arguments: {} }], { stopReason: 'toolUse' }),
      piToolResult('call-1', 'read_file', 'tool result'),
      piAssistant('done'),
    ]);
  });
});

function makeInput(text: string): RuntimeInput {
  return { id: `input-${text}`, text, source: 'ui', createdAt: Date.now() };
}

function makeSnapshot(messages: AgentRuntimeSnapshot['messages']): AgentRuntimeSnapshot {
  return {
    providerId: 'openai',
    protocol: 'openai_chat_completions',
    model: 'test-model',
    effort: 'none',
    role: 'default',
    messageFormat: 'pi-ai-v1',
    messages,
    usageHistory: [],
    lastUsage: undefined,
  };
}

function makeAgent(
  getSnapshot: () => AgentRuntimeSnapshot,
  loadSnapshot: (snapshot: AgentRuntimeSnapshot) => void,
): AgentRuntime {
  return { getSnapshot, loadSnapshot, taskOwnerId: 'agent-test' } as unknown as AgentRuntime;
}
