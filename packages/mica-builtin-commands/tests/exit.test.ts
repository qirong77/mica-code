import { describe, expect, it, vi } from 'vitest';
import type { CommandRuntimeServices } from '../services.js';

const { createExitCommand } = await import('../commands/exit.js');

describe('exit command', () => {
  it('requests application exit through runtime services', async () => {
    const services = { requestExit: vi.fn() } as unknown as CommandRuntimeServices;

    await createExitCommand(services).action();

    expect(services.requestExit).toHaveBeenCalledWith(0);
  });
});
