import { lstatSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';
import { notebookMcp } from '../migrations.js';
import type { DataMigration } from './types.js';

function readRecord(path: string): Record<string, unknown> | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export const notebookMcpData: DataMigration = {
  id: 'notebook-mcp',
  description: '归档 Notebook 旧插件 skill 索引，并迁移默认能力中的笔记工具停用项；不改笔记正文或用户 skill',
  run({ home }) {
    let changed = 0;
    const config = join(home, 'config.json');
    const release = acquireProcessLock(`${config}.lock`);
    if (release) {
      try {
        const record = readRecord(config);
        if (record && notebookMcp.apply(record) > 0) {
          writeTextFileAtomic(config, `${JSON.stringify(record, null, 2)}\n`);
          changed += 1;
        }
      } finally { release(); }
    }
    const index = join(home, 'plugin-skills', 'notebook.json');
    const releaseIndex = acquireProcessLock(`${index}.lock`);
    if (!releaseIndex) return changed;
    try {
      const record = readRecord(index);
      if (record?.pluginId !== 'notebook' || record.version !== 2 || !Array.isArray(record.skills)) return changed;
      if (!record.skills.every((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).name === 'notebook')) return changed;
      const archive = join(home, 'plugin-data', 'evolution', 'legacy-notebook-skill');
      mkdirSync(archive, { recursive: true, mode: 0o700 });
      renameSync(index, join(archive, `${randomUUID()}.json`));
      return changed + 1;
    } finally { releaseIndex(); }
  },
};
