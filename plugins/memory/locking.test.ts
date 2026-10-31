import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireMemoryLock } from './locking.js';

const roots: string[] = [];
const lockPath = () => {
  const root = mkdtempSync(join(tmpdir(), 'mica-memory-lock-'));
  roots.push(root);
  return join(root, 'memory.lock');
};
const abandonedClaim = '123456789-00000000-0000-0000-0000-000000000000';

function orphan(path: string): void {
  mkdirSync(`${path}.owners`, { recursive: true });
  writeFileSync(join(`${path}.owners`, abandonedClaim), '');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('memory process locks', () => {
  it('excludes another holder and makes release idempotent without removing a newer claim', () => {
    const path = lockPath();
    const release = acquireMemoryLock(path)!;
    expect(acquireMemoryLock(path)).toBeNull();
    release();
    const releaseNext = acquireMemoryLock(path)!;
    release();
    expect(readdirSync(`${path}.owners`)).toHaveLength(1);
    expect(acquireMemoryLock(path)).toBeNull();
    releaseNext();
    expect(readdirSync(`${path}.owners`)).toEqual([]);
  });

  it('reclaims a claim left by an exited owner', () => {
    const path = lockPath();
    orphan(path);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no process'), { code: 'ESRCH' });
    });

    const release = acquireMemoryLock(path);

    expect(release).not.toBeNull();
    expect(readdirSync(`${path}.owners`)).toEqual([expect.stringMatching(new RegExp(`^${process.pid}-`))]);
    release?.();
  });

  it('does not grant two claims while an orphan is being recovered', () => {
    const path = lockPath();
    orphan(path);
    let second: (() => void) | null | undefined;
    let interleaved = false;
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 123456789) {
        if (!interleaved) {
          interleaved = true;
          // 在发现孤儿与删除孤儿之间插入另一次完整申请；它必须看见第一个 claim。
          second = acquireMemoryLock(path);
        }
        throw Object.assign(new Error('no process'), { code: 'ESRCH' });
      }
      return true;
    });

    const first = acquireMemoryLock(path);

    expect(interleaved).toBe(true);
    expect(second).toBeNull();
    expect(first).not.toBeNull();
    expect(readdirSync(`${path}.owners`)).toHaveLength(1);
    first?.();
  });

  it('recognizes an active owner before any claim content is written', () => {
    const path = lockPath();
    mkdirSync(`${path}.owners`, { recursive: true });
    const active = `${process.pid}-00000000-0000-0000-0000-000000000000`;
    writeFileSync(join(`${path}.owners`, active), '');

    expect(acquireMemoryLock(path)).toBeNull();
    expect(readdirSync(`${path}.owners`)).toEqual([active]);
  });

  it('keeps another claim when its owner cannot be inspected', () => {
    const path = lockPath();
    orphan(path);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });

    expect(acquireMemoryLock(path)).toBeNull();
    expect(readdirSync(`${path}.owners`)).toEqual([abandonedClaim]);
  });
});
