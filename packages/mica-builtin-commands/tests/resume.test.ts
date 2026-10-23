import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResumeCommand, formatResumeSessionTitle } from '../index.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from '../services.js';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mica-resume-')));
  tempDirs.push(dir);
  return dir;
}

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

  it('switches the process working directory to the resumed session cwd', async () => {
    const sessionCwd = tempDir();
    const showNotice = vi.fn();
    const sessionController = {
      load: vi.fn(() => ({ cwd: sessionCwd, snapshot: { model: 'test-model' } })),
      resume: vi.fn(() => ({
        ok: true as const,
        session: { title: 'Other session', cwd: sessionCwd, snapshot: { model: 'test-model' } },
      })),
    } as unknown as CommandSessionController;
    const services = {
      isAgentBusy: () => false,
      ensureModelRule: vi.fn().mockResolvedValue(undefined),
      syncModelDisplay: vi.fn(),
      refreshCurrentAgentSessionUi: vi.fn(),
      syncAgentStatusItems: vi.fn(),
      showNotice,
    } as unknown as CommandRuntimeServices;

    await createResumeCommand({} as CommandAgent, sessionController, services).action('session-2');

    expect(process.cwd()).toBe(sessionCwd);
    expect(services.syncAgentStatusItems).toHaveBeenCalledOnce();
    expect(showNotice.mock.calls[0]?.[2]).toMatchObject({ status: 'success' });
  });

  it('warns but still resumes when the session cwd is gone', async () => {
    const missingCwd = join(tempDir(), 'deleted-project');
    const showNotice = vi.fn();
    const sessionController = {
      load: vi.fn(() => ({ cwd: missingCwd, snapshot: { model: 'test-model' } })),
      resume: vi.fn(() => ({
        ok: true as const,
        session: { title: 'Other session', cwd: missingCwd, snapshot: { model: 'test-model' } },
      })),
    } as unknown as CommandSessionController;
    const services = {
      isAgentBusy: () => false,
      ensureModelRule: vi.fn().mockResolvedValue(undefined),
      syncModelDisplay: vi.fn(),
      refreshCurrentAgentSessionUi: vi.fn(),
      syncAgentStatusItems: vi.fn(),
      showNotice,
    } as unknown as CommandRuntimeServices;

    await createResumeCommand({} as CommandAgent, sessionController, services).action('session-2');

    expect(sessionController.resume).toHaveBeenCalledWith('session-2');
    expect(process.cwd()).toBe(originalCwd);
    expect(showNotice.mock.calls[0]?.[2]).toMatchObject({ status: 'warning' });
  });
});
