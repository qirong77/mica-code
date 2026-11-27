import { describe, expect, it } from 'vitest';
import {
  isSessionInWorkspace,
  projectConversation,
  projectHistoryPage,
  reconcileTurnState,
  safeSessionAlias,
  workspaceRefFor,
} from './index.js';

const autoSession = {
  title: '帮我检查公司内部接口',
  titleSource: 'auto',
};

describe('session projection', () => {
  it('publishes only manual titles', () => {
    expect(safeSessionAlias(autoSession)).toBeUndefined();
    expect(safeSessionAlias({ title: '家里的重构', titleSource: 'manual' })).toBe('家里的重构');
    expect(safeSessionAlias({ title: '   ', titleSource: 'manual' })).toBeUndefined();
  });

  it('keeps user/assistant text and drops internal context', () => {
    const raw = {
      snapshot: {
        systemPrompt: 'TOP SECRET SYSTEM PROMPT',
        conversationMessages: [
          { role: 'user', content: '检查入口' },
          { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }] },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: '已检查。' },
              { type: 'toolCall', name: 'read_file', input: '/etc/passwd' },
              { type: 'image', data: 'BASE64' },
            ],
          },
          { role: 'notice', content: '工具输出不应外传' },
          { role: 'assistant', content: '' },
        ],
      },
    };
    expect(projectConversation(raw)).toEqual([
      { role: 'user', text: '检查入口' },
      { role: 'assistant', text: '已检查。\n[图片]' },
    ]);
  });

  it('pages from the newest message backwards', () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `m${index}`,
    }));
    const raw = { snapshot: { conversationMessages: messages } };
    const first = projectHistoryPage({
      raw,
      sessionRef: 's1',
      revision: 'r1',
      limit: 2,
      maxBytes: 10_000,
      now: new Date('2026-11-27T00:00:00Z'),
    });
    expect(first.messages.map((message) => message.text)).toEqual(['m3', 'm4']);
    expect(first.nextCursor).toBe('2');
    const second = projectHistoryPage({
      raw,
      sessionRef: 's1',
      revision: 'r1',
      cursor: Number(first.nextCursor),
      limit: 2,
      maxBytes: 10_000,
    });
    expect(second.messages.map((message) => message.text)).toEqual(['m1', 'm2']);
    const third = projectHistoryPage({
      raw,
      sessionRef: 's1',
      revision: 'r1',
      cursor: Number(second.nextCursor),
      limit: 2,
      maxBytes: 10_000,
    });
    expect(third.messages.map((message) => message.text)).toEqual(['m0']);
    expect(third.nextCursor).toBeNull();
  });

  it('clips a page that would exceed the byte budget', () => {
    const raw = {
      snapshot: {
        conversationMessages: [
          { role: 'user', content: 'a'.repeat(5000) },
          { role: 'assistant', content: 'b'.repeat(5000) },
        ],
      },
    };
    const page = projectHistoryPage({ raw, sessionRef: 's1', revision: 'r1', maxBytes: 600 });
    expect(page.messages.length).toBe(1);
    expect(page.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThanOrEqual(600);
  });

  it('binds sessions to a workspace without exposing the path', () => {
    const workspace = '/Users/someone/workspace';
    expect(
      isSessionInWorkspace(
        { sessionId: 's', path: '/x', updatedAt: 'now', turnState: 'completed', cwd: workspace },
        workspace,
      ),
    ).toBe(true);
    expect(
      isSessionInWorkspace(
        { sessionId: 's', path: '/x', updatedAt: 'now', turnState: 'completed', cwd: '/Users/someone/other' },
        workspace,
      ),
    ).toBe(false);
    expect(workspaceRefFor(workspace)).toMatch(/^[a-z2-7]{20}$/);
    expect(workspaceRefFor(workspace)).not.toContain('workspace');
  });

  it('downgrades a stale running turn without a live lease', () => {
    const summary = {
      sessionId: 's',
      path: '/x',
      updatedAt: 'now',
      turnState: 'running',
    };
    expect(reconcileTurnState(summary, new Set(['s'])).turnState).toBe('running');
    expect(reconcileTurnState(summary, new Set()).turnState).toBe('unknown');
    expect(reconcileTurnState({ ...summary, turnState: 'completed' }, new Set()).turnState).toBe(
      'completed',
    );
  });
});
