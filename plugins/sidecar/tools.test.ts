import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SidecarRegistry } from './registry.js';
import { SidecarSpawnTool, SidecarWaitTool } from './tools.js';
import { SidecarTranscript } from './transcript.js';

afterEach(() => vi.useRealTimers());

describe('sidecar tool boundaries', () => {
  it.each([{ until: 'typo' }, { timeout_ms: 0 }, { timeout_ms: -1 }, { timeout_ms: NaN }, { timeout_ms: Infinity }])(
    'rejects invalid wait input before subscribing: %j',
    async (input) => {
      const get = vi.fn();
      const tool = new SidecarWaitTool({ get } as unknown as SidecarRegistry);
      expect(await tool.execute({ session_id: 'child', ...input })).toMatch(/必须/);
      expect(get).not.toHaveBeenCalled();
    },
  );

  it('passes the parent cancellation signal through a spawn', async () => {
    const spawn = vi.fn(async () => ({ ok: false, error: 'cancelled' }));
    const controller = new AbortController();
    const tool = new SidecarSpawnTool({ spawn } as unknown as SidecarRegistry);
    await tool.execute({ prompt: 'work', max_turns: 0 }, { signal: controller.signal });
    expect(spawn).toHaveBeenCalledWith({ prompt: 'work', maxTurns: 0, signal: controller.signal });
  });

  it('cancels an outstanding wait without advancing the polling clock', async () => {
    vi.useFakeTimers();
    const transcript = new SidecarTranscript();
    transcript.apply({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
    const waitForChange = vi.fn(
      (_timeout: number, signal?: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          signal?.addEventListener('abort', () => resolve(false), { once: true });
        }),
    );
    const entry = { id: 'child', process: { transcript, closed: false, waitForChange } };
    const tool = new SidecarWaitTool({ get: () => entry } as unknown as SidecarRegistry);
    const controller = new AbortController();
    const started = Date.now();
    const waiting = tool.execute({ session_id: 'child' }, { signal: controller.signal });
    expect(waitForChange).toHaveBeenCalledWith(500, controller.signal);
    controller.abort();
    expect(await waiting).toContain('已取消等待');
    expect(Date.now()).toBe(started);
  });
});
