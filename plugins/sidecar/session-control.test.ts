import { describe, expect, it, vi } from 'vitest';
import { SessionControlTool } from './tools.js';

function target() {
  return {
    id: 'target-session',
    process: {
      closed: false,
      send: vi.fn(async () => ({ queued: false })),
      abort: vi.fn(async () => true),
    },
  };
}

describe('session-control', () => {
  it('sends and pauses a session by id', async () => {
    const entry = target();
    const registry = {
      isCurrentSession: () => false,
      ensureAttached: vi.fn(async () => ({ ok: true as const, entry })),
      close: vi.fn(async () => true),
      markRead: vi.fn(),
    };
    const tool = new SessionControlTool(registry as never);

    expect(await tool.execute({ session_id: entry.id, action: 'start', text: '开始 X' })).toContain('启动一轮');
    expect(entry.process.send).toHaveBeenCalledWith('开始 X');
    expect(await tool.execute({ session_id: entry.id, action: 'pause' })).toContain('已暂停');
    expect(entry.process.abort).toHaveBeenCalledOnce();
  });

  it('attaches an unregistered session before sending and does not control itself', async () => {
    const entry = target();
    const ensureAttached = vi.fn(async () => ({ ok: true as const, entry }));
    const registry = {
      isCurrentSession: (id: string) => id === 'current',
      ensureAttached,
      close: vi.fn(async () => true),
      markRead: vi.fn(),
    };
    const tool = new SessionControlTool(registry as never);

    expect(await tool.execute({ session_id: 'other', action: 'resume', text: '继续' })).toContain('发送消息');
    expect(ensureAttached).toHaveBeenCalledWith('other', undefined);
    expect(await tool.execute({ session_id: 'current', action: 'pause' })).toContain('不能');
    expect(ensureAttached).toHaveBeenCalledOnce();
  });

  it('requires text for start and accepts an empty resume', async () => {
    const entry = target();
    const registry = {
      isCurrentSession: () => false,
      ensureAttached: vi.fn(async () => ({ ok: true as const, entry })),
      close: vi.fn(async () => true),
      markRead: vi.fn(),
    };
    const tool = new SessionControlTool(registry as never);
    expect(await tool.execute({ session_id: entry.id, action: 'start' })).toContain('需要提供 text');
    expect(await tool.execute({ session_id: entry.id, action: 'resume' })).toContain('已接回');
  });
});
