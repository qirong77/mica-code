import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandRuntimeServices } from './services.js';

const mocks = {
  logRuntime: vi.fn(),
};

vi.mock('@packages/mica-logger/index.js', () => ({
  micaLogger: {
    logRuntime: mocks.logRuntime,
  },
}));

const { createExitCommand } = await import('./exit.js');

describe('exit command', () => {
  beforeEach(() => {
    mocks.logRuntime.mockReset();
  });

  it('requests application exit through runtime services', async () => {
    const services = { requestExit: vi.fn() } as unknown as CommandRuntimeServices;

    await createExitCommand(services).action();

    expect(mocks.logRuntime).toHaveBeenCalledWith('plugin.exit', 'requested');
    expect(services.requestExit).toHaveBeenCalledWith(0);
  });
});
