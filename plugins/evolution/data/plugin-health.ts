import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';
import { pluginHealthIssuesV2 } from '../migrations.js';
import type { DataMigration } from './types.js';

export const pluginStartupHealth: DataMigration = {
  id: 'plugin-startup-health',
  description: 'Archive legacy setup errors from runtime plugin health; setup status belongs to the host',
  run({ home }) {
    const root = join(home, 'plugin-health');
    let names: string[];
    try {
      if (!lstatSync(root).isDirectory()) return 0;
      names = readdirSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    let changed = 0;
    for (const name of names) {
      if (!/^[a-z0-9][a-z0-9._-]*\.json$/.test(name)) continue;
      const path = join(root, name);
      const release = acquireProcessLock(`${path}.lock`);
      if (!release) continue;
      try {
        let record: unknown;
        try {
          if (!lstatSync(path).isFile()) continue;
          record = JSON.parse(readFileSync(path, 'utf8'));
        } catch {
          continue;
        }
        if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
        const health = record as Record<string, unknown>;
        if (health.level !== 'error' || typeof health.message !== 'string' || !health.message.startsWith('启动失败：'))
          continue;
        const archive = join(home, 'plugin-data', 'evolution', 'legacy-plugin-health');
        mkdirSync(archive, { recursive: true, mode: 0o700 });
        renameSync(path, join(archive, `${name.slice(0, -5)}-${randomUUID()}.json`));
        changed += 1;
      } finally {
        release();
      }
    }
    return changed;
  },
};

export const pluginHealthIssues: DataMigration = {
  id: pluginHealthIssuesV2.id,
  description: pluginHealthIssuesV2.description,
  run({ home }) {
    const root = join(home, 'plugin-health');
    let names: string[];
    try {
      if (!lstatSync(root).isDirectory()) return 0;
      names = readdirSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    let changed = 0;
    for (const name of names) {
      if (!/^[a-z0-9][a-z0-9._-]*\.json$/.test(name)) continue;
      const path = join(root, name);
      const release = acquireProcessLock(`${path}.lock`);
      if (!release) continue;
      try {
        let original: string;
        let record: unknown;
        try {
          if (!lstatSync(path).isFile()) continue;
          original = readFileSync(path, 'utf8');
          record = JSON.parse(original);
        } catch {
          continue;
        }
        if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
        if (pluginHealthIssuesV2.apply(record as Record<string, unknown>) === 0) continue;
        // Archive before replacement, even when session backups are disabled.
        // A deterministic name makes a retry after interruption idempotent.
        const archive = join(home, 'plugin-data', 'evolution', 'legacy-plugin-health');
        mkdirSync(archive, { recursive: true, mode: 0o700 });
        const digest = createHash('sha256').update(original).digest('hex');
        const target = join(archive, `${name.slice(0, -5)}-${digest}.json`);
        try {
          writeFileSync(target, original, { flag: 'wx', mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (readFileSync(target, 'utf8') !== original) throw new Error('Conflicting plugin health archive');
        }
        writeTextFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
        changed += 1;
      } finally {
        release();
      }
    }
    return changed;
  },
};
