import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestExit, setOnExitRequested } from './state.js';

afterEach(() => {
  setOnExitRequested(null);
  vi.restoreAllMocks();
});

describe('terminal input exit requests', () => {
  it('passes the exit code to the registered handler and awaits cleanup', async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const handler = vi.fn(() => cleanup);
    setOnExitRequested(handler);

    let completed = false;
    const pending = requestExit(7).then(() => {
      completed = true;
    });
    await Promise.resolve();

    expect(handler).toHaveBeenCalledWith(7);
    expect(completed).toBe(false);

    finishCleanup();
    await pending;
    expect(completed).toBe(true);
  });

  it('falls back to process.exit when no application handler is registered', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await requestExit(9);

    expect(exit).toHaveBeenCalledWith(9);
  });
});
