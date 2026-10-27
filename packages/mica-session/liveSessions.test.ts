import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listRecentSessionFiles, listSessionTurnLocks } from './liveSessions.js';

const createdDirs: string[] = [];

function makeSessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mica-live-sessions-'));
  createdDirs.push(dir);
  mkdirSync(resolve(dir, '.turn-locks'), { recursive: true });
  return dir;
}

function writeLease(sessionDir: string, id: string, owner: unknown): string {
  const lockPath = resolve(sessionDir, '.turn-locks', `${id}.lock`);
  writeFileSync(lockPath, typeof owner === 'string' ? owner : JSON.stringify(owner));
  return lockPath;
}

function writeSession(sessionDir: string, id: string, body: string): string {
  const sessionPath = resolve(sessionDir, `${id}.json`);
  writeFileSync(sessionPath, body);
  return sessionPath;
}

function sessionBody(id: string, title: string, extra = '', updatedAt = '2026-10-02T03:04:05.000Z'): string {
  return `{
  "version": 1,
  "id": "${id}",
  "title": ${JSON.stringify(title)},
  "titleSource": "derived",
  "createdAt": "2026-10-01T00:00:00.000Z",
  "updatedAt": "${updatedAt}",
  "cwd": "/tmp/project",
  "turnState": "running",
  "snapshot": {
    "providerId": "mock",
    "model": "mock-chat",
    "messages": [],
    "conversationMessages": []${extra}
  }
}
`;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('listSessionTurnLocks', () => {
  it('lists a lease whose holder process is alive and reads the session head', () => {
    const sessionDir = makeSessionDir();
    const lockPath = writeLease(sessionDir, 'sess-live', {
      pid: 4242,
      token: 'tok',
      createdAt: '2026-10-02T03:00:00.000Z',
    });
    const sessionPath = writeSession(sessionDir, 'sess-live', sessionBody('sess-live', '修复 "登录" 超时'));

    const locks = listSessionTurnLocks({ sessionDir, isAlive: (pid) => pid === 4242 });

    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({
      sessionId: 'sess-live',
      pid: 4242,
      alive: true,
      startedAt: '2026-10-02T03:00:00.000Z',
      lockPath,
      sessionPath,
      title: '修复 "登录" 超时',
      cwd: '/tmp/project',
      updatedAt: '2026-10-02T03:04:05.000Z',
      turnState: 'running',
      model: 'mock-chat',
    });
  });

  it('marks a lease whose holder is gone as stale instead of dropping it', () => {
    const sessionDir = makeSessionDir();
    writeLease(sessionDir, 'sess-dead', { pid: 999_999, createdAt: '2026-10-02T03:00:00.000Z' });

    const locks = listSessionTurnLocks({ sessionDir, isAlive: () => false });

    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({ sessionId: 'sess-dead', pid: 999_999, alive: false });
    expect(locks[0]!.title).toBeUndefined();
  });

  it('skips unreadable or malformed leases and returns nothing without a lease dir', () => {
    const sessionDir = makeSessionDir();
    writeLease(sessionDir, 'torn', '{"pid":');
    writeLease(sessionDir, 'no-pid', { token: 'tok' });
    expect(listSessionTurnLocks({ sessionDir, isAlive: () => true })).toEqual([]);

    const emptyDir = makeSessionDir();
    rmSync(resolve(emptyDir, '.turn-locks'), { recursive: true, force: true });
    expect(listSessionTurnLocks({ sessionDir: emptyDir, isAlive: () => true })).toEqual([]);
  });

  it('never parses the whole session file, so metadata still resolves for a huge snapshot', () => {
    const sessionDir = makeSessionDir();
    writeLease(sessionDir, 'sess-big', { pid: 7, createdAt: '2026-10-02T03:00:00.000Z' });
    // 2 MB of tool history after the head must not be needed for the summary.
    writeSession(
      sessionDir,
      'sess-big',
      sessionBody('sess-big', '大文件会话', `,\n    "padding": "${'x'.repeat(2_000_000)}"`),
    );

    const [lock] = listSessionTurnLocks({ sessionDir, isAlive: () => true });

    expect(lock).toMatchObject({ sessionId: 'sess-big', title: '大文件会话', turnState: 'running' });
  });

  it('orders leases by turn start time', () => {
    const sessionDir = makeSessionDir();
    writeLease(sessionDir, 'later', { pid: 2, createdAt: '2026-10-02T05:00:00.000Z' });
    writeLease(sessionDir, 'earlier', { pid: 1, createdAt: '2026-10-02T04:00:00.000Z' });

    const locks = listSessionTurnLocks({ sessionDir, isAlive: () => true });

    expect(locks.map((lock) => lock.sessionId)).toEqual(['earlier', 'later']);
  });
});

describe('listRecentSessionFiles', () => {
  const now = Date.parse('2026-10-02T06:00:00.000Z');

  function touch(path: string, iso: string): void {
    const seconds = Date.parse(iso) / 1000;
    utimesSync(path, seconds, seconds);
  }

  it('lists sessions written inside the window with metadata read from the head', () => {
    const sessionDir = makeSessionDir();
    const recent = writeSession(sessionDir, 'sess-recent', sessionBody('sess-recent', '刚结束的会话'));
    const old = writeSession(sessionDir, 'sess-old', sessionBody('sess-old', '很久以前的会话'));
    touch(recent, '2026-10-02T05:00:00.000Z');
    touch(old, '2026-09-01T05:00:00.000Z');

    const files = listRecentSessionFiles({ sessionDir, since: now - 24 * 3_600_000 });

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      sessionId: 'sess-recent',
      sessionPath: recent,
      title: '刚结束的会话',
      cwd: '/tmp/project',
      turnState: 'running',
      model: 'mock-chat',
    });
  });

  it('trusts a stale header over a freshly touched file and ignores non-session entries', () => {
    const sessionDir = makeSessionDir();
    const stale = writeSession(sessionDir, 'sess-stale', sessionBody('sess-stale', '头部过期'));
    touch(stale, '2026-10-02T05:59:00.000Z');
    writeFileSync(resolve(sessionDir, 'session-index.json'), '{ "sessions": [] }');
    writeFileSync(resolve(sessionDir, 'notes.txt'), 'not a session');

    const files = listRecentSessionFiles({ sessionDir, since: now - 3_600_000 });

    // The header says 2026-10-02T03:04:05Z, well outside the one-hour window.
    expect(files).toEqual([]);
  });

  it('orders newest first and honours the limit', () => {
    const sessionDir = makeSessionDir();
    const older = writeSession(
      sessionDir,
      'sess-older',
      sessionBody('sess-older', '旧一点', '', '2026-10-02T05:10:00.000Z'),
    );
    const newer = writeSession(
      sessionDir,
      'sess-newer',
      sessionBody('sess-newer', '新一点', '', '2026-10-02T05:30:00.000Z'),
    );
    touch(older, '2026-10-02T05:00:00.000Z');
    touch(newer, '2026-10-02T05:30:00.000Z');

    const files = listRecentSessionFiles({ sessionDir, since: now - 3_600_000, limit: 1 });

    expect(files.map((file) => file.sessionId)).toEqual(['sess-newer']);
  });

  it('returns nothing when the session dir is missing', () => {
    expect(
      listRecentSessionFiles({ sessionDir: join(tmpdir(), 'mica-live-sessions-missing'), since: now }),
    ).toEqual([]);
  });
});
