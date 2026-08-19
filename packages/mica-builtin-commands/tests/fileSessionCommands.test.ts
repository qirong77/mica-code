import { describe, expect, it, vi } from 'vitest';
import { createForkCommand, createNewCommand, createRenameCommand } from '../index.js';
import type { CommandRuntimeServices, CommandSessionController } from '../services.js';

describe('single-file session commands', () => {
  it('/new creates and switches to a foreground agent session', () => {
    const session = { id: 'agent-2', index: 2 };
    const services = makeServices({ newSession: session });

    createNewCommand(services).action();

    expect(services.newAgentSession).toHaveBeenCalledOnce();
    expect(services.switchAgentSession).toHaveBeenCalledWith('agent-2');
    expect(services.showNotice).toHaveBeenCalledWith('Created agent #2', undefined, {
      command: '/new',
      status: 'success',
    });
  });

  it('/fork submits a prompt in the forked session without switching to it', async () => {
    const forked = { id: 'agent-3', index: 3, sourceWasRunning: true };
    const services = makeServices({ forked });

    createForkCommand(services).action('continue in background');

    await vi.waitFor(() => {
      expect(services.submitAgentSessionInput).toHaveBeenCalledWith('agent-3', 'continue in background');
    });
    expect(services.switchAgentSession).not.toHaveBeenCalled();
    expect(services.showNotice).toHaveBeenCalledWith('Forked agent #3 in background', undefined, {
      command: '/fork',
      status: 'success',
    });
  });

  it('/rename updates persisted and retained session titles', () => {
    const sessionController = { renameCurrent: vi.fn() } as unknown as CommandSessionController;
    const services = makeServices({});

    createRenameCommand(sessionController, services).action('  Better title  ');

    expect(sessionController.renameCurrent).toHaveBeenCalledWith('Better title');
    expect(services.renameCurrentAgentSession).toHaveBeenCalledWith('Better title');
    expect(services.showNotice).toHaveBeenCalledWith('Session renamed to: Better title', undefined, {
      command: '/rename',
      status: 'success',
    });
  });
});

function makeServices(options: {
  newSession?: { id: string; index: number };
  forked?: { id: string; index: number; sourceWasRunning: boolean };
}): CommandRuntimeServices {
  return {
    newAgentSession: vi.fn(() => options.newSession),
    forkCurrentAgent: vi.fn(() => options.forked),
    switchAgentSession: vi.fn(),
    submitAgentSessionInput: vi.fn(async () => ({ ok: true as const })),
    showMessage: vi.fn(),
    showNotice: vi.fn(),
    renameCurrentAgentSession: vi.fn(),
  } as unknown as CommandRuntimeServices;
}
