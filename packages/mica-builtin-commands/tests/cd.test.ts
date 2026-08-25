import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { micaUi } from '@packages/mica-ui/index.js';
import { collectRecentCwds, createCdCommand } from '../index.js';
import type { CommandRuntimeServices, CommandSessionController, SessionSummary } from '../services.js';

const originalCwd = process.cwd();
const temporaryDirectories: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  micaUi.panels.clearPluginUIs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('cd command', () => {
  it('keeps cwd order while removing duplicates and empty values', () => {
    expect(collectRecentCwds([{ cwd: '/recent' }, { cwd: '/older' }, { cwd: '/recent' }, { cwd: '' }])).toEqual([
      '/recent',
      '/older',
    ]);
  });

  it('queries 100 recent sessions and changes the process cwd when Enter is pressed', async () => {
    const target = makeTemporaryDirectory();
    const expectedCwd = realpathSync(target);
    const listRecent = vi.fn(() => [session(target), session(target)]);
    const services = { showMessage: vi.fn(), showNotice: vi.fn() } as unknown as CommandRuntimeServices;
    const controller = {
      list: vi.fn(() => []),
      listRecent,
    } as unknown as CommandSessionController;

    createCdCommand(controller, services).action();
    const panel = micaUi.panels.pluginUIs.get()[0];
    expect(panel?.id).toBe('select-cwd');

    panel?.onInput?.('', { return: true });
    await vi.waitFor(() => expect(process.cwd()).toBe(expectedCwd));

    expect(listRecent).toHaveBeenCalledWith(100);
    expect(services.showNotice).toHaveBeenCalledWith(`Working directory: ${expectedCwd}`, undefined, {
      command: '/cd',
      status: 'success',
    });
  });

  it('keeps the current cwd when a saved directory no longer exists', async () => {
    const missing = join(tmpdir(), `mica-cd-missing-${Date.now()}`);
    const services = { showMessage: vi.fn(), showNotice: vi.fn() } as unknown as CommandRuntimeServices;
    const controller = {
      listRecent: vi.fn(() => [session(missing)]),
    } as unknown as CommandSessionController;

    createCdCommand(controller, services).action();
    micaUi.panels.pluginUIs.get()[0]?.onInput?.('', { return: true });
    await vi.waitFor(() => expect(services.showNotice).toHaveBeenCalled());

    expect(process.cwd()).toBe(originalCwd);
    expect(services.showNotice).toHaveBeenCalledWith(
      expect.stringContaining('Unable to change working directory:'),
      undefined,
      { command: '/cd', status: 'error' },
    );
  });
});

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mica-cd-'));
  temporaryDirectories.push(directory);
  return directory;
}

function session(cwd: string): SessionSummary {
  return {
    id: cwd,
    title: cwd,
    updatedAt: new Date().toISOString(),
    cwd,
    model: 'test',
    uncompleted: false,
  };
}
