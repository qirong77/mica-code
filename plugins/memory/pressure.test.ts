import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryRepository } from './store.js';

// Opt in: real local processes exercise the cross-process read/modify/write locks.
describe.skipIf(process.env.MICA_PLUGIN_REVIEW_PRESSURE !== '1')('memory and tag process pressure', () => {
  it('preserves every concurrent memory addition and tag assignment', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mica-memory-pressure-'));
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const source = `
      import { join } from 'node:path';
      import { MemoryRepository } from './plugins/memory/store.ts';
      import setupTags from './plugins/session-tags/index.ts';
      const worker = process.env.MICA_PRESSURE_WORKER;
      const home = process.env.MICA_HOME;
      const repository = new MemoryRepository({ rootDir: join(home, 'memory'), budgets: { user: 20000, memory: 20000, project: 20000 } });
      let command;
      let sessionId = '';
      setupTags({
        pluginId: 'session-tags', paths: { config: home },
        session: { describe: () => ({ id: sessionId }) },
        commands: { register: (value) => { command = value; return { dispose() {} }; } },
        logger: { info() {}, warn() {} }, health: { report() {} }, ui: { showMessage() {} }, onDispose() {},
      });
      const retry = async (run) => {
        for (let attempt = 0; attempt < 2000; attempt += 1) {
          if (run()) return;
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        throw new Error('lock retry budget exhausted');
      };
      for (let index = 0; index < 50; index += 1) {
        await retry(() => repository.apply('memory', [{ action: 'add', content: 'worker ' + worker + ' fact ' + index }]).ok);
        sessionId = 'worker-' + worker + '-' + index;
        await retry(() => command.handler({}, 'add red blue').ok);
      }
    `;
    try {
      await Promise.all(
        Array.from(
          { length: 4 },
          (_, worker) =>
            new Promise<void>((resolve, reject) => {
              const child = spawn('bun', ['--eval', source], {
                cwd: root,
                env: { ...process.env, MICA_HOME: home, MICA_PLUGIN_LOG: '0', MICA_PRESSURE_WORKER: String(worker) },
                stdio: ['ignore', 'pipe', 'pipe'],
              });
              let output = '';
              child.stdout.on('data', (chunk) => {
                output += chunk;
              });
              child.stderr.on('data', (chunk) => {
                output += chunk;
              });
              child.on('error', reject);
              child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${worker}: ${output}`))));
            }),
        ),
      );
      const repository = new MemoryRepository({ rootDir: join(home, 'memory') });
      const entries = repository.read('memory');
      expect(entries).toHaveLength(200);
      expect(new Set(entries).size).toBe(200);
      expect(statSync(join(home, 'memory', 'MEMORY.md')).mode & 0o777).toBe(0o600);
      const annotations = join(home, 'plugin-data', 'session-tags', 'session-annotations.json');
      const assignments = JSON.parse(readFileSync(annotations, 'utf8')).assignments as Record<string, string[]>;
      expect(Object.keys(assignments)).toHaveLength(200);
      expect(Object.values(assignments).every((ids) => ids.join(',') === 'red,blue')).toBe(true);
      expect(readdirSync(`${annotations}.lock.owners`)).toEqual([]);
      expect(readdirSync(join(home, 'memory', 'MEMORY.md.lock.owners'))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
