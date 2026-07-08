import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import { createMemoryUsageCommand } from './memoryUsage.js';
import type { CommandRuntimeServices } from './services.js';

describe('memoryUsage command', () => {
  beforeEach(() => {
    micaRuntime.memoryUsageMonitor.stop();
    micaRuntime.memoryUsageMonitor.clear();
  });

  it('exports retained memory snapshots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mica-memory-usage-export-test-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(dir);
      micaRuntime.memoryUsageMonitor.capture('test:before');
      const services = createServices();

      createMemoryUsageCommand(services).action('export');

      const exportDir = findExportDir(dir);
      const exportedFiles = readdirSync(exportDir);
      const manifest = readJson(join(exportDir, 'manifest.log'));
      const memoryUsage = readJson(join(exportDir, 'memory-usage.log'));
      const summary = readFileSync(join(exportDir, 'memory-usage-summary.log'), 'utf-8');

      expect(exportedFiles.every((name) => name.endsWith('.log'))).toBe(true);
      expect(manifest.files).toEqual([
        'manifest.log',
        'diagnostics.log',
        'memory-usage.log',
        'memory-usage-summary.log',
      ]);
      expect(memoryUsage.totalSnapshots).toBeGreaterThanOrEqual(2);
      expect(memoryUsage.snapshots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'test:before' }),
          expect.objectContaining({ label: 'command:export' }),
        ]),
      );
      expect(summary).toContain('RSS');
      expect(services.showMessage).toHaveBeenCalledWith(expect.stringContaining('memoryUsage export'), 8000);
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function createServices(): CommandRuntimeServices {
  return {
    showMessage: vi.fn(),
  } as unknown as CommandRuntimeServices;
}

function findExportDir(dir: string): string {
  const entry = readdirSync(dir).find((name) => name.startsWith('mica-memory-usage-export-'));
  if (!entry) throw new Error('export directory not found');
  return join(dir, entry);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'));
}
