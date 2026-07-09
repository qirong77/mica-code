import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadFilePlugins } from './FilePluginLoader.js';

describe('loadFilePlugins', () => {
  it('loads mjs plugins from the plugins directory in filename order', async () => {
    const dir = mkTempDir();
    try {
      writeFileSync(join(dir, '20-second.mjs'), 'export default function setup() {}');
      writeFileSync(join(dir, '10-first.mjs'), 'export default function setup() {}');
      writeFileSync(join(dir, 'ignored.txt'), 'nope');

      const result = await loadFilePlugins({ pluginsDir: dir });

      expect(result.failed).toEqual([]);
      expect(result.plugins.map((plugin) => plugin.id)).toEqual(['file.10-first', 'file.20-second']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps loading when one plugin file is invalid', async () => {
    const dir = mkTempDir();
    const warn = vi.fn();
    try {
      writeFileSync(join(dir, 'bad.mjs'), 'export const nope = 1');
      writeFileSync(join(dir, 'good.mjs'), 'export default function setup() {}');

      const result = await loadFilePlugins({ pluginsDir: dir, logger: { warn } });

      expect(result.plugins.map((plugin) => plugin.id)).toEqual(['file.good']);
      expect(result.failed).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith('file-plugin:load-failed', expect.objectContaining({ file: join(dir, 'bad.mjs') }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function mkTempDir(): string {
  const dir = join(tmpdir(), `mica-file-plugin-loader-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
