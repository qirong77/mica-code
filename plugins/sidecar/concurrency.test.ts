import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { SidecarRegistry } from './registry.js';
import { SidecarProcess } from './sidecarProcess.js';

afterEach(() => vi.restoreAllMocks());

function harness() {
  let session = { id: 'parent-1', cwd: '/tmp/first', role: 'first-role' };
  const ctx = {
    session: { describe: () => session },
    logger: { info: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
  const registry = new SidecarRegistry(ctx, session.id, session.cwd, () => session.role);
  return {
    registry,
    setSession: (next: typeof session) => {
      session = next;
    },
  };
}

function processFor(id: string) {
  return {
    sessionId: id,
    cwd: '/tmp',
    closed: false,
    close: vi.fn(async () => undefined),
    send: vi.fn(async () => ({ queued: false })),
  } as unknown as SidecarProcess;
}

describe('SidecarRegistry startup', () => {
  it('awaits children already closing after a parent switch before completing disposal', async () => {
    const { registry, setSession } = harness();
    const child = processFor('closing-child');
    let finishClose!: () => void;
    vi.spyOn(child, 'close').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishClose = resolve;
        }),
    );
    vi.spyOn(SidecarProcess, 'start').mockResolvedValue(child);
    await registry.spawn({ prompt: 'work' });
    setSession({ id: 'parent-2', cwd: '/tmp/second', role: 'second-role' });
    expect(registry.list()).toEqual([]);
    let disposed = false;
    const disposing = registry.closeAll().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(disposed).toBe(false);
    finishClose();
    await disposing;
    expect(disposed).toBe(true);
  });

  it('closes a child cancelled while its initial prompt is awaiting acknowledgement', async () => {
    const { registry } = harness();
    const controller = new AbortController();
    const child = processFor('cancelled-child');
    let rejectSend!: (error: Error) => void;
    vi.spyOn(child, 'send').mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectSend = reject;
        }),
    );
    vi.spyOn(child, 'close').mockImplementation(async () => {
      rejectSend?.(new Error('closed'));
    });
    vi.spyOn(SidecarProcess, 'start').mockResolvedValue(child);
    const spawning = registry.spawn({ prompt: 'work', signal: controller.signal });
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledOnce());
    controller.abort();
    expect(await spawning).toMatchObject({ ok: false, error: '派生子会话已取消。' });
    expect(child.close).toHaveBeenCalledWith(0);
    expect(registry.list()).toEqual([]);
    await registry.closeAll();
  });

  it('forwards cancellation through the startup handshake and releases its reserved slot', async () => {
    const { registry } = harness();
    const controller = new AbortController();
    let startupSignal: AbortSignal | undefined;
    const start = vi.spyOn(SidecarProcess, 'start').mockImplementationOnce((options) => {
      startupSignal = options.signal;
      return new Promise((_, reject) => {
        options.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    });
    const spawning = registry.spawn({ prompt: 'work', signal: controller.signal });
    controller.abort();
    expect(startupSignal?.aborted).toBe(true);
    expect((await spawning).ok).toBe(false);
    start.mockResolvedValue(processFor('replacement'));
    expect((await registry.spawn({ prompt: 'replacement' })).ok).toBe(true);
    await registry.closeAll();
  });

  it('starts children in parallel without a fixed cap', async () => {
    const { registry } = harness();
    const starts: Array<(value: SidecarProcess) => void> = [];
    vi.spyOn(SidecarProcess, 'start').mockImplementation(
      () => new Promise((resolve) => starts.push(resolve)),
    );
    const attempts = Array.from({ length: 12 }, (_, index) => registry.spawn({ prompt: `work ${index}` }));
    for (const [index, resolveStored] of starts.entries()) resolveStored(processFor(`child-${index}`));
    const results = await Promise.all(attempts);
    expect(results.every((result) => result.ok)).toBe(true);
    await registry.closeAll();
  });

  it('closes a child whose handshake finishes during disposal without sending its prompt', async () => {
    const { registry } = harness();
    let finishStart!: (value: SidecarProcess) => void;
    vi.spyOn(SidecarProcess, 'start').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStart = resolve;
        }),
    );
    const spawning = registry.spawn({ prompt: 'work' });
    const closing = registry.closeAll();
    const child = processFor('child-1');
    finishStart(child);
    const result = await spawning;
    await closing;
    expect(result.ok).toBe(false);
    expect(child.send).not.toHaveBeenCalled();
    expect(child.close).toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
    expect((await registry.spawn({ prompt: 'after disposal' })).ok).toBe(false);
  });

  it('reads the parent session at spawn time and isolates access after a session switch', async () => {
    const { registry, setSession } = harness();
    const start = vi
      .spyOn(SidecarProcess, 'start')
      .mockResolvedValueOnce(processFor('child-1'))
      .mockResolvedValueOnce(processFor('child-2'));
    await registry.spawn({ prompt: 'first' });
    setSession({ id: 'parent-2', cwd: '/tmp/second', role: 'second-role' });
    expect(registry.get('child-1')).toBeNull();
    expect(registry.list()).toEqual([]);
    await registry.spawn({ prompt: 'second' });
    expect(start.mock.calls[1]?.[0]).toMatchObject({
      parentSessionId: 'parent-2',
      cwd: '/tmp/second',
      role: 'second-role',
    });
    expect(registry.list().map((entry) => entry.id)).toEqual(['child-2']);
    await registry.closeAll();
  });

  it('cancels a spawn if its parent session changed during the handshake', async () => {
    const { registry, setSession } = harness();
    let finishStart!: (value: SidecarProcess) => void;
    vi.spyOn(SidecarProcess, 'start').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStart = resolve;
        }),
    );
    const spawning = registry.spawn({ prompt: 'work for the first session' });
    setSession({ id: 'parent-2', cwd: '/tmp/second', role: 'second-role' });
    const child = processFor('child-1');
    finishStart(child);
    expect((await spawning).ok).toBe(false);
    expect(child.send).not.toHaveBeenCalled();
    expect(child.close).toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
    await registry.closeAll();
  });
});

describe('SidecarRegistry spawn overrides', () => {
  it('treats placeholder model/effort as inherit instead of passing them to the child', async () => {
    // 真链路里模型会把可选参数填成 "default"：照传就是 `--model default`，
    // 子会话起得来、第一句话却因为「模型不存在」失败。
    const { registry } = harness();
    const start = vi.spyOn(SidecarProcess, 'start').mockResolvedValue(processFor('placeholder-child'));
    const result = await registry.spawn({ prompt: 'work', model: 'default', effort: 'inherit' });
    expect(result.ok).toBe(true);
    const options = start.mock.calls[0]?.[0] as { model?: string; effort?: string };
    expect(options.model).toBeUndefined();
    expect(options.effort).toBeUndefined();
  });

  it('passes a real model id through untouched', async () => {
    const { registry } = harness();
    const start = vi.spyOn(SidecarProcess, 'start').mockResolvedValue(processFor('model-child'));
    await registry.spawn({ prompt: 'work', model: 'deepseek/deepseek-flash', effort: 'high' });
    const options = start.mock.calls[0]?.[0] as { model?: string; effort?: string };
    expect(options.model).toBe('deepseek/deepseek-flash');
    expect(options.effort).toBe('high');
  });
});
