import { describe, expect, it, vi } from 'vitest';
import { createResumeCommand, formatResumeSessionTitle } from '../../../buildin-plugins/command-resume.mjs';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from '../services.js';

describe('formatResumeSessionTitle', () => {
  it('prefixes sessions whose last turn did not complete', () => {
    expect(formatResumeSessionTitle({ title: 'Fix checkout', uncompleted: true })).toBe('（uncompleted）Fix checkout');
  });

  it('keeps completed session titles unchanged', () => {
    expect(formatResumeSessionTitle({ title: 'Fix checkout', uncompleted: false })).toBe('Fix checkout');
  });

  it('loads the target model rule before resuming another persisted session', async () => {
    const clearRewindCheckpoints = vi.fn();
    const sessionController = {
      load: vi.fn(() => ({ snapshot: { model: 'test-model' } })),
      resume: vi.fn(() => ({
        ok: true as const,
        session: { title: 'Other session', snapshot: { model: 'test-model' } },
      })),
    } as unknown as CommandSessionController;
    const services = {
      isAgentBusy: () => false,
      clearRewindCheckpoints,
      ensureModelRule: vi.fn().mockResolvedValue(undefined),
      syncModelDisplay: vi.fn(),
      refreshCurrentAgentSessionUi: vi.fn(),
      showMessage: vi.fn(),
      showNotice: vi.fn(),
    } as unknown as CommandRuntimeServices;

    await createResumeCommand({} as CommandAgent, sessionController, services).action('session-2');

    expect(services.ensureModelRule).toHaveBeenCalledWith('test-model');
    expect(sessionController.resume).toHaveBeenCalledWith('session-2');
    expect(clearRewindCheckpoints).toHaveBeenCalledOnce();
  });
});
