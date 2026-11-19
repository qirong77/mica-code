import { join } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { AUDIT_FILE, AUDIT_LOCK, projectAuditEntry, storedAuditEntry } from '../../ssh/Audit.js';
import {
  archivePrivateOriginal,
  hasDataDirectory,
  privateJsonLines,
  readBoundedPrivateFile,
  replacePrivateFile,
} from './private-files.js';
import type { DataMigration } from './types.js';

export const sshAuditV2: DataMigration = {
  id: 'ssh-audit-v2',
  description: 'Archive raw SSH audit history and replace it with explicitly versioned private hash-only records',
  run({ home, log }) {
    if (!hasDataDirectory(home, 'plugin-data', 'ssh')) return 0;
    const root = join(home, 'plugin-data', 'ssh');
    const release = acquireProcessLock(join(root, AUDIT_LOCK));
    if (!release) {
      log('evolution:ssh-audit-skipped', { reason: 'busy' });
      return 0;
    }
    try {
      const path = join(root, AUDIT_FILE);
      const original = readBoundedPrivateFile(path, 8 * 1024 * 1024);
      if (!original) return 0;
      const rows = privateJsonLines(original);
      const projected = rows.map((row) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Unsupported audit record');
        const version = (row as Record<string, unknown>).schemaVersion;
        const entry = version === undefined ? projectAuditEntry(row) : version === 2 ? storedAuditEntry(row) : null;
        if (!entry) throw new Error('Unsupported audit record');
        return entry;
      });
      const changed = projected.filter((entry, index) => JSON.stringify(entry) !== JSON.stringify(rows[index])).length;
      if (changed === 0) return 0;
      archivePrivateOriginal(home, 'legacy-ssh-audit', AUDIT_FILE, original);
      replacePrivateFile(path, `${projected.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
      return changed;
    } catch {
      // Do not turn a corrupt/partial stream into a plausible completed history.
      log('evolution:ssh-audit-skipped', { reason: 'unreadable_or_unsupported' });
      return 0;
    } finally {
      release();
    }
  },
};
