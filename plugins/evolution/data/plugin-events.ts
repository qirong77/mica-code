import { join } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import {
  archivePrivateOriginal,
  hasDataDirectory,
  privateJsonLines,
  readBoundedPrivateFile,
  replacePrivateFile,
} from './private-files.js';
import type { DataMigration } from './types.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const FILES = ['plugin-events.jsonl', 'plugin-events.1.jsonl'];

function token(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && /^[a-z0-9][a-z0-9:._+-]*$/i.test(value);
}

function identityRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unsupported plugin event');
  const record = value as Record<string, unknown>;
  if (
    (record.schemaVersion !== undefined && record.schemaVersion !== 2) ||
    typeof record.at !== 'string' ||
    !Number.isFinite(Date.parse(record.at)) ||
    typeof record.pluginId !== 'string' ||
    !record.pluginId.trim() ||
    record.pluginId.length > 200 ||
    typeof record.taskId !== 'string' ||
    !record.taskId.trim() ||
    record.taskId.length > 200 ||
    !Number.isSafeInteger(record.tick) ||
    Number(record.tick) < 0 ||
    !Number.isSafeInteger(record.failures) ||
    Number(record.failures) < 0 ||
    typeof record.error !== 'string'
  )
    throw new Error('Unsupported plugin event');
  return {
    ...record,
    schemaVersion: 2,
    pluginVersion: token(record.pluginVersion, 60) ? record.pluginVersion : 'unknown',
    pid: Number.isSafeInteger(record.pid) && Number(record.pid) > 0 ? record.pid : null,
    generation: token(record.generation, 80) ? record.generation : 'unknown',
  };
}

export const pluginEventIdentity: DataMigration = {
  id: 'plugin-events-identity-v2',
  description: 'Version plugin failure histories with explicit unknown historical producer identities',
  run({ home, log }) {
    if (!hasDataDirectory(home, 'plugin-data', 'harness-review')) return 0;
    const root = join(home, 'plugin-data', 'harness-review');
    const release = acquireProcessLock(join(root, 'plugin-events.lock'));
    if (!release) {
      log('evolution:plugin-events-skipped', { reason: 'busy' });
      return 0;
    }
    let changed = 0;
    try {
      for (const name of FILES) {
        try {
          const path = join(root, name);
          const original = readBoundedPrivateFile(path, MAX_FILE_BYTES);
          if (!original) continue;
          const rows = privateJsonLines(original);
          const projected = rows.map(identityRecord);
          const count = projected.filter((row, index) => JSON.stringify(row) !== JSON.stringify(rows[index])).length;
          if (count === 0) continue;
          archivePrivateOriginal(home, 'legacy-plugin-events', name, original);
          replacePrivateFile(path, `${projected.map((row) => JSON.stringify(row)).join('\n')}\n`);
          changed += count;
        } catch {
          // Unknown/corrupt/oversized histories are not partial migration inputs.
          log('evolution:plugin-events-skipped', { file: name, reason: 'unreadable_or_unsupported' });
        }
      }
    } finally {
      release();
    }
    return changed;
  },
};
