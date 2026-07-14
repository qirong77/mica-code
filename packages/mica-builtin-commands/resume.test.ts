import { describe, expect, it, vi } from 'vitest';
import { createResumeCommand, formatResumeSessionTitle } from './resume.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from './services.js';

describe('formatResumeSessionTitle', () => {
  it('prefixes sessions whose last turn did not complete', () => {
    expect(formatResumeSessionTitle({ title: 'Fix checkout', uncompleted: true })).toBe(
      '（uncompleted）Fix checkout',
    );
  });

  it('keeps completed session titles unchanged', () => {
    expect(formatResumeSessionTitle({ title: 'Fix checkout', uncompleted: false })).toBe('Fix checkout');
  });

  it('clears rewind checkpoints after resuming another persisted session', () => {
    const clearRewindCheckpoints = vi.fn();
    const sessionController = {
      resume: vi.fn(() => ({
        ok: true as const,
        session: { title: 'Other session', snapshot: { model: 'test-model' } },
      })),
    } as unknown as CommandSessionController;
    const services = {
      isAgentBusy: () => false,
      clearRewindCheckpoints,
      syncModelDisplay: vi.fn(),
      refreshCurrentAgentSessionUi: vi.fn(),
      showMessage: vi.fn(),
    } as unknown as CommandRuntimeServices;

    createResumeCommand({} as CommandAgent, sessionController, services).action('session-2');

    expect(clearRewindCheckpoints).toHaveBeenCalledOnce();
  });
});
