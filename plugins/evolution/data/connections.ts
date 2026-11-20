import { randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { PEER_STORE_VERSION, normalizePeerStore, type PeerStore } from '../../connections/peers.js';
import { archivePrivateOriginal } from './private-files.js';
import type { DataMigration } from './types.js';

const MAX_CONNECTIONS_FILE_BYTES = 1024 * 1024;

/** 将 Connections 的旧地址清单一次性迁为 version 1；运行时不再解释旧形态。 */
export const connectionsPeerStore: DataMigration = {
  id: 'connections-peer-store',
  description: '将 Connections 旧地址数组迁为 version 1 清单，原文归档后原子替换',
  run({ home, log }) {
    const file = join(home, 'plugin-data', 'connections', 'data.json');
    if (!safeDataDirectory(home) || !isRegularFile(file)) return 0;

    let release: (() => void) | null = null;
    try {
      release = acquireProcessLock(`${file}.lock`);
      if (!release) return 0;
      if (!safeDataDirectory(home) || !isRegularFile(file)) return 0;

      const original = readStableFile(file);
      if (!original) return 0;
      const parsed = parseJson(original);
      const legacyPeers = legacyPeerList(parsed);
      if (!legacyPeers) return 0;

      const store = normalizePeerStore({ version: PEER_STORE_VERSION, peers: legacyPeers });
      archivePrivateOriginal(home, 'legacy-connections', 'data.json', original);
      writeCurrentFile(file, store);
      return 1;
    } catch (error) {
      // A malformed, replaced, linked, or otherwise unsafe file must remain untouched. The next
      // startup can retry after the user or the active writer has made the situation safe.
      log('evolution:connections-migration-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    } finally {
      release?.();
    }
  },
};

function legacyPeerList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value.map(asLegacyPeerEntry);
  if (!isRecord(value) || Object.prototype.hasOwnProperty.call(value, 'version') || !Array.isArray(value.peers)) {
    return null;
  }
  return value.peers.map(asLegacyPeerEntry);
}

function asLegacyPeerEntry(value: unknown): unknown {
  return typeof value === 'string' ? { url: value, note: '' } : value;
}

function parseJson(original: Buffer): unknown | null {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(original)) as unknown;
  } catch {
    return null;
  }
}

function safeDataDirectory(home: string): boolean {
  return isDirectory(join(home, 'plugin-data')) && isDirectory(join(home, 'plugin-data', 'connections'));
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function readStableFile(path: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.size > MAX_CONNECTIONS_FILE_BYTES) return null;
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) return null;
      offset += count;
    }
    const after = lstatSync(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null;
    return buffer;
  } finally {
    closeSync(fd);
  }
}

function writeCurrentFile(path: string, store: PeerStore): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let created = false;
  try {
    // rename replaces a symlink itself rather than following it, so this never writes through one.
    if (!isRegularFile(path)) throw new Error('Connections data file is no longer a regular file');
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { flag: 'wx', mode: 0o600, encoding: 'utf8' });
    created = true;
    renameSync(temporary, path);
    created = false;
  } finally {
    if (created) unlinkSync(temporary);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
