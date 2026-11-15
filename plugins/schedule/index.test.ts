import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import setup from './index.js';
import { ScheduleTool } from './ScheduleTool.js';
import manifest from './plugin.json';

it('registers only the schedule tool without a skills capability or skill files', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'mica-schedule-plugin-'));
  const dispose = vi.fn();
  const register = vi.fn(() => ({ dispose }));
  const disposers: Array<() => void> = [];
  try {
    setup({
      pluginId: 'schedule',
      paths: { config: configDir },
      tools: { register },
      logger: { info: vi.fn() },
      onDispose: (callback: () => void) => disposers.push(callback),
    } as unknown as PluginContext);

    expect(manifest.requires).toEqual(['tools']);
    expect(register).toHaveBeenCalledExactlyOnceWith(expect.any(ScheduleTool), {
      icon: '📅',
      primaryAgentOnly: true,
    });
    expect(existsSync(join(configDir, 'plugin-data', 'schedule', 'skill'))).toBe(false);

    for (const callback of disposers) callback();
    expect(dispose).toHaveBeenCalledOnce();
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
