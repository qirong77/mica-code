import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PersistedSession } from './sessionStore.js';

const previousMicaHome = process.env.MICA_HOME;

afterEach(() => {
  if (previousMicaHome === undefined) delete process.env.MICA_HOME;
  else process.env.MICA_HOME = previousMicaHome;
  vi.resetModules();
});

describe('SessionStore path', () => {
  it('distinguishes an atomic replacement even with identical size and mtime', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-stat-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();
      store.save(makeSession('polled', '/tmp', '2026-01-01T00:00:00.000Z'));
      const path = join(SESSION_DIR, 'polled.json');
      const before = statSync(path);
      const signature = store.statSignature('polled');
      expect(signature).not.toBeNull();
      expect(store.statSignature('polled')).toBe(signature);

      const replacement = `${path}.replacement`;
      writeFileSync(replacement, readFileSync(path));
      utimesSync(replacement, before.atime, before.mtime);
      renameSync(replacement, path);
      expect(statSync(path).size).toBe(before.size);
      expect(Math.floor(statSync(path).mtimeMs / 1000)).toBe(Math.floor(before.mtimeMs / 1000));
      expect(store.statSignature('polled')).not.toBe(signature);
      expect(store.statSignature('missing')).toBeNull();
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });
  it('keeps headless sessions inside MICA_HOME when it is set', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-home-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SESSION_DIR } = await import('./sessionStore.js');
      expect(SESSION_DIR).toBe(resolve(micaHome, 'sessions'));
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('lists sessions strictly by recency before applying the limit', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-recent-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore } = await import('./sessionStore.js');
      const store = new SessionStore();

      store.save(makeSession('old-current-cwd', process.cwd(), '2026-01-01T00:00:00.000Z'));
      store.save(makeSession('newest', '/tmp/newest', '2026-01-03T00:00:00.000Z'));
      store.save(makeSession('middle', '/tmp/middle', '2026-01-02T00:00:00.000Z'));

      expect(store.listRecent(2).map((session) => session.id)).toEqual(['newest', 'middle']);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });
});

describe('SessionStore metadata index', () => {
  it('persists recency order and reloads from the index without parsing session bodies', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-index-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();

      store.save(makeSession('newest', '/tmp/newest', '2026-01-03T00:00:00.000Z'));
      store.save(makeSession('middle', '/tmp/middle', '2026-01-02T00:00:00.000Z'));
      store.save(makeSession('oldest', '/tmp/oldest', '2026-01-01T00:00:00.000Z'));

      // The index lives outside sessions/ so directory scans stay unaffected.
      const indexFile = join(micaHome, 'session-index.json');
      expect(existsSync(indexFile)).toBe(true);
      expect(existsSync(join(SESSION_DIR, 'session-index.json'))).toBe(false);

      // A fresh store reads the index: a corrupt session body must be ignored.
      writeFileSync(join(SESSION_DIR, 'newest.json'), '{ not valid json', 'utf-8');
      const reloaded = new SessionStore();
      expect(reloaded.listRecent(10).map((session) => session.id)).toEqual(['newest', 'middle', 'oldest']);

      reloaded.delete('newest');
      expect(reloaded.listRecent(10).map((session) => session.id)).toEqual(['middle', 'oldest']);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('describes a large session from its head instead of parsing the body', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-head-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      mkdirSync(SESSION_DIR, { recursive: true });
      // 头部是合法 JSON（侧栏要的字段全在里面），后面故意写成坏 JSON：
      // 只要索引还整份解析，这条会话就会被判成损坏而从列表里消失。
      const head = JSON.stringify({
        version: 1,
        id: 'huge',
        title: 'Huge session',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
        cwd: '/tmp/huge',
        turnState: 'completed',
        parentSessionId: 'parent-1',
        snapshot: {
          providerId: 'test',
          protocol: 'openai_responses',
          model: 'mock-chat',
          effort: 'medium',
          role: 'default',
        },
      }).slice(0, -1);
      writeFileSync(join(SESSION_DIR, 'huge.json'), `${head},"padding":"${'x'.repeat(80_000)}",,,`, 'utf-8');

      const store = new SessionStore();
      const listed = store.list(10);
      expect(listed.map((session) => session.id)).toEqual(['huge']);
      expect(listed[0]).toMatchObject({
        title: 'Huge session',
        cwd: '/tmp/huge',
        parentSessionId: 'parent-1',
        model: 'mock-chat',
        effort: 'medium',
        role: 'default',
        turnState: 'completed',
      });
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });
});

describe('session turn lease', () => {
  it('serializes turns for one session and releases idempotently', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-lease-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { acquireSessionTurnLease } = await import('./sessionStore.js');

      const first = acquireSessionTurnLease('shared-session');
      expect(first).not.toBeNull();
      expect(acquireSessionTurnLease('shared-session')).toBeNull();
      const other = acquireSessionTurnLease('other-session');
      expect(other).not.toBeNull();

      first?.release();
      first?.release();
      const next = acquireSessionTurnLease('shared-session');
      expect(next).not.toBeNull();
      next?.release();
      other?.release();
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('reclaims a stale lock left by a dead host process', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-stale-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { acquireSessionTurnLease, SESSION_DIR } = await import('./sessionStore.js');

      // Simulate a host that crashed mid-turn: its pid is no longer alive and
      // the lock file was never released. A fresh acquire must reclaim it.
      const lockDir = resolve(SESSION_DIR, '.turn-locks');
      mkdirSync(lockDir, { recursive: true });
      const lockPath = resolve(lockDir, 'crashed-session.lock');
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: 999_999_999, token: 'stale', createdAt: new Date().toISOString() }),
        'utf-8',
      );

      const lease = acquireSessionTurnLease('crashed-session');
      expect(lease).not.toBeNull();
      lease?.release();
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('deletes a session together with any leftover turn-lock', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-delete-lock-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();
      store.save(makeSession('to-delete', '/tmp/to-delete', '2026-01-01T00:00:00.000Z'));

      const lockPath = resolve(SESSION_DIR, '.turn-locks', 'to-delete.lock');
      mkdirSync(resolve(SESSION_DIR, '.turn-locks'), { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'x' }), 'utf-8');
      const btwPath = resolve(micaHome, 'btw', 'to-delete.json');
      mkdirSync(resolve(micaHome, 'btw'), { recursive: true });
      writeFileSync(btwPath, JSON.stringify({ version: 1, threads: [] }), 'utf-8');
      expect(existsSync(btwPath)).toBe(true);

      expect(store.delete('to-delete')).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
      // By The Way 的线程按会话落盘，删会话必须一起删掉（否则重开同名 id 会捡到幽灵线程）。
      expect(existsSync(btwPath)).toBe(false);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('clears an orphan turn-lock when deleting an id whose session file is already gone', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-delete-orphan-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();

      // A crash left a lock behind after the session file was removed elsewhere.
      // Deleting the id must clean up the orphan lock even though no session file
      // exists anymore, otherwise a later continue/resume of the id stays stuck.
      const lockPath = resolve(SESSION_DIR, '.turn-locks', 'gone-session.lock');
      mkdirSync(resolve(SESSION_DIR, '.turn-locks'), { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'x' }), 'utf-8');

      expect(store.delete('gone-session')).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });
});

describe('SessionStore.replaceValidated', () => {
  it('validates and atomically replaces an existing completed session', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-replace-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore } = await import('./sessionStore.js');
      const store = new SessionStore();
      const original = makeSession('editable', '/tmp/editable', '2026-01-01T00:00:00.000Z');
      store.save(original);

      const replacement = { ...original, title: 'Edited title', updatedAt: '2026-01-02T00:00:00.000Z' };
      expect(store.replaceValidated('editable', JSON.stringify(replacement)).title).toBe('Edited title');
      expect(store.load('editable')).toMatchObject({ title: 'Edited title', updatedAt: replacement.updatedAt });
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('rejects malformed JSON, mismatched ids, and running sessions', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-reject-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore } = await import('./sessionStore.js');
      const store = new SessionStore();
      const completed = makeSession('completed', '/tmp/completed', '2026-01-01T00:00:00.000Z');
      const running = {
        ...makeSession('running', '/tmp/running', '2026-01-01T00:00:00.000Z'),
        turnState: 'running' as const,
      };
      store.save(completed);
      store.save(running);

      expect(() => store.replaceValidated('completed', '{')).toThrow('Invalid session JSON');
      expect(() => store.replaceValidated('completed.json', JSON.stringify(completed))).toThrow('Invalid session id');
      expect(() => store.replaceValidated('completed', JSON.stringify({ ...completed, id: 'other' }))).toThrow(
        'Session id mismatch',
      );
      expect(() => store.replaceValidated('running', JSON.stringify(running))).toThrow(
        'Cannot replace running session',
      );
      expect(() => store.replaceValidated('completed', JSON.stringify({ ...completed, turnState: 'running' }))).toThrow(
        'Cannot save running session',
      );
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('keeps a display checkpoint only when its model and protocol match the snapshot', async () => {
    const { parsePersistedSession } = await import('./sessionStore.js');
    const session = makeSession('thinking', '/tmp', '2026-01-01T00:00:00.000Z');
    session.snapshot.protocol = 'openai_responses';
    session.snapshot.interruptedThinking = {
      providerId: session.snapshot.providerId,
      protocol: 'openai_responses',
      model: session.snapshot.model,
      apiBase: 'https://example.com',
      text: 'complete thinking',
    };
    expect(parsePersistedSession(session)?.snapshot.interruptedThinking?.text).toBe('complete thinking');
    expect(
      parsePersistedSession({ ...session, snapshot: { ...session.snapshot, model: 'other' } })?.snapshot
        .interruptedThinking,
    ).toBeUndefined();
    expect(
      parsePersistedSession({ ...session, snapshot: { ...session.snapshot, protocol: 'openai_chat_completions' } })
        ?.snapshot.interruptedThinking,
    ).toBeUndefined();
  });

  it('round-trips and sanitizes active thinking using the same rules as interrupted thinking', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-active-thinking-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, parsePersistedSession } = await import('./sessionStore.js');
      const store = new SessionStore();
      const session = makeSession('active-thinking', '/tmp', '2026-01-01T00:00:00.000Z');
      session.turnState = 'running';
      session.snapshot.protocol = 'openai_responses';
      const thinking = {
        providerId: session.snapshot.providerId,
        protocol: 'openai_responses' as const,
        model: session.snapshot.model,
        apiBase: 'https://example.com',
        text: 'completed part',
      };
      session.snapshot.activeThinking = thinking;
      session.snapshot.interruptedThinking = { ...thinking, text: 'earlier part' };
      store.save(session);
      expect(store.load(session.id)?.snapshot).toMatchObject({
        activeThinking: thinking,
        interruptedThinking: { ...thinking, text: 'earlier part' },
      });
      for (const invalid of [
        { providerId: 'other' },
        { model: 'other' },
        { protocol: 'openai_chat_completions' },
        { apiBase: 12 },
        { text: '' },
      ]) {
        const parsed = parsePersistedSession({
          ...session,
          snapshot: { ...session.snapshot, activeThinking: { ...thinking, ...invalid } },
        });
        expect(parsed?.snapshot.activeThinking).toBeUndefined();
        expect(parsed?.snapshot.interruptedThinking?.text).toBe('earlier part');
      }
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('keeps awaitingInput only while the turn is unfinished, and trims it', async () => {
    const { parsePersistedSession } = await import('./sessionStore.js');
    const session = makeSession('awaiting-input', '/tmp', '2026-01-01T00:00:00.000Z');
    session.turnState = 'running';

    expect(parsePersistedSession({ ...session, awaitingInput: '  等你选方案  ' })?.awaitingInput).toBe(
      '等你选方案',
    );
    // 这一轮已经跑完了，还挂着「等你选」会让侧栏一直喊一个已经不存在的问题。
    expect(
      parsePersistedSession({ ...session, turnState: 'completed', awaitingInput: '等你选方案' })?.awaitingInput,
    ).toBeUndefined();
    // 空串、非字符串同样只是丢掉这个可选字段，不拒绝整条会话。
    expect(parsePersistedSession({ ...session, awaitingInput: '   ' })?.awaitingInput).toBeUndefined();
    expect(parsePersistedSession({ ...session, awaitingInput: 42 } as unknown as typeof session)?.awaitingInput).toBe(
      undefined,
    );
    // 侧栏只放得下一行，超长截断而不是整条丢掉。
    const long = 'x'.repeat(400);
    expect(parsePersistedSession({ ...session, awaitingInput: long })?.awaitingInput?.length).toBe(120);
  });

  it('preserves valid running inputs and drops malformed or stale recovery data', async () => {
    const { parsePersistedSession } = await import('./sessionStore.js');
    const session = makeSession('active-input', '/tmp', '2026-01-01T00:00:00.000Z');
    session.turnState = 'running';
    session.snapshot.protocol = 'openai_responses';
    const input = [
      { type: 'text' as const, text: 'inspect this' },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'YWJj' } },
    ];
    session.snapshot.activeTurn = { input, committed: false };
    expect(parsePersistedSession(JSON.parse(JSON.stringify(session)))?.snapshot.activeTurn).toEqual({
      input,
      committed: false,
    });
    expect(parsePersistedSession({ ...session, turnState: 'completed' })?.snapshot.activeTurn).toBeUndefined();
    expect(
      parsePersistedSession({ ...session, snapshot: { ...session.snapshot, protocol: 'openai_chat_completions' } })
        ?.snapshot.activeTurn,
    ).toBeUndefined();
    for (const invalid of [
      { input, committed: 'false' },
      { input: [{ type: 'unknown' }], committed: false },
      {
        input: [{ type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'x' } }],
        committed: false,
      },
    ]) {
      const parsed = parsePersistedSession({ ...session, snapshot: { ...session.snapshot, activeTurn: invalid } });
      expect(parsed?.snapshot.activeTurn).toBeUndefined();
      expect(parsed?.snapshot.messages).toEqual(session.snapshot.messages);
    }
    // A model change invalidates thinking, but never discards the user's input.
    expect(
      parsePersistedSession({ ...session, snapshot: { ...session.snapshot, model: 'other' } })?.snapshot.activeTurn,
    ).toEqual({ input, committed: false });
  });

  it('drops broken turn timings instead of rejecting the whole session', async () => {
    const { parsePersistedSession } = await import('./sessionStore.js');
    const raw = {
      version: 1,
      id: 'timed',
      title: 'Timed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp/project',
      snapshot: {
        providerId: 'test',
        model: 'test-model',
        effort: 'none',
        messages: [],
        conversationMessages: [],
        usageHistory: [],
        turnTimings: [
          null,
          { startedAt: 2000, endedAt: 2500, outcome: 'completed', segments: [] },
          { startedAt: 1000, endedAt: 1500, outcome: 'aborted', segments: [{ kind: 'wait', start: 1000, end: 1200 }] },
          { startedAt: 'x', endedAt: 1 },
        ],
      },
    };
    const parsed = parsePersistedSession(raw);
    expect(parsed?.snapshot.turnTimings?.map((record) => record.startedAt)).toEqual([1000, 2000]);
    // 坏条目只影响「耗时」页签，不该让会话本身读不出来。
    expect(parsed?.title).toBe('Timed');
  });

  it('parses legacy defaults without mutating the caller value', async () => {
    const { parsePersistedSession } = await import('./sessionStore.js');
    const raw = {
      version: 1,
      id: 'legacy-compatible',
      title: 'Legacy compatible',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp/project',
      snapshot: {
        providerId: 'test',
        model: 'test-model',
        effort: 'none',
        messages: [],
        conversationMessages: [],
        usageHistory: [],
      },
    };
    const before = JSON.stringify(raw);

    expect(parsePersistedSession(raw)).toMatchObject({
      turnState: 'completed',
      snapshot: { protocol: 'openai_chat_completions', role: 'default' },
    });
    expect(JSON.stringify(raw)).toBe(before);
    expect(parsePersistedSession({ ...raw, snapshot: { ...raw.snapshot, usageHistory: {} } })).toBeNull();
  });

  it('keeps a parent session id only when it could be a real session', async () => {
    const { parsePersistedSession } = await import('./sessionStore.js');
    const raw = {
      version: 1,
      id: 'child',
      title: 'Child',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp/project',
      parentSessionId: 'parent',
      snapshot: {
        providerId: 'test',
        model: 'test-model',
        effort: 'none',
        messages: [],
        conversationMessages: [],
        usageHistory: [],
      },
    };
    expect(parsePersistedSession(raw)).toMatchObject({ parentSessionId: 'parent' });
    // 坏值只丢这一个展示线索，不拒绝整条会话——否则一条脏数据会让会话从列表里消失。
    expect(parsePersistedSession({ ...raw, parentSessionId: 42 })).toMatchObject({ parentSessionId: undefined });
    expect(parsePersistedSession({ ...raw, parentSessionId: '../escape' })).toMatchObject({
      parentSessionId: undefined,
    });
    // 自指会让侧栏嵌套成环。
    expect(parsePersistedSession({ ...raw, parentSessionId: 'child' })).toMatchObject({
      parentSessionId: undefined,
    });
  });

  it('keeps the last request system prompt and drops a malformed one', async () => {
    const { parsePersistedSession } = await import('./sessionStore.js');
    const raw = {
      version: 1,
      id: 'prompted',
      title: 'Prompted',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp/project',
      snapshot: {
        providerId: 'test',
        model: 'test-model',
        effort: 'none',
        systemPrompt: '<system>\nbe brief\n</system>',
        messages: [],
        conversationMessages: [],
        usageHistory: [],
      },
    };
    expect(parsePersistedSession(raw)).toMatchObject({
      snapshot: { systemPrompt: '<system>\nbe brief\n</system>' },
    });
    // 只影响提示词页签，脏值丢弃而不是拒绝整条会话。
    expect(parsePersistedSession({ ...raw, snapshot: { ...raw.snapshot, systemPrompt: '' } })).toMatchObject({
      snapshot: { systemPrompt: undefined },
    });
    expect(parsePersistedSession({ ...raw, snapshot: { ...raw.snapshot, systemPrompt: 42 } })).toMatchObject({
      snapshot: { systemPrompt: undefined },
    });
  });
});

describe('SessionStore index reconciliation', () => {
  it('rebuilds the index to recover sessions a stale index dropped', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-recover-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();
      store.save(makeSession('real', '/tmp/real', '2026-01-01T00:00:00.000Z'));

      // Simulate another process persisting a session without updating the
      // index (as happens when a stale in-memory index overwrites the file).
      writeFileSync(
        join(SESSION_DIR, 'orphan.json'),
        JSON.stringify(makeSession('orphan', '/tmp/orphan', '2026-01-02T00:00:00.000Z')),
        'utf-8',
      );

      expect(store.listRecent(10).map((session) => session.id)).toEqual(['orphan', 'real']);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('keeps sessions saved by another store instance instead of dropping them', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-merge-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore } = await import('./sessionStore.js');
      const first = new SessionStore();
      first.save(makeSession('a', '/tmp/a', '2026-01-01T00:00:00.000Z'));
      const second = new SessionStore();
      second.save(makeSession('b', '/tmp/b', '2026-01-02T00:00:00.000Z'));

      // The second writer must not clobber the first writer's entry from the index.
      expect(new SessionStore().listRecent(10).map((session) => session.id)).toEqual(['b', 'a']);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('records unreadable legacy files so a new session does not trigger a full rebuild', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-legacy-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();
      store.save(makeSession('real', '/tmp/real', '2026-01-01T00:00:00.000Z'));

      // 两种 v1 之前的旧格式：裸消息数组与 {id,title,updatedAt,messages}。
      writeFileSync(
        join(SESSION_DIR, 'legacy-array.json'),
        JSON.stringify([{ role: 'user', content: 'old prompt' }]),
        'utf-8',
      );
      writeFileSync(
        join(SESSION_DIR, 'legacy-object.json'),
        JSON.stringify({ id: 'legacy-object', title: 'old', updatedAt: '2025-01-01T00:00:00.000Z', messages: [] }),
        'utf-8',
      );

      // 第一次读：重建一次，把两个旧文件记成 rejects 并落盘。
      expect(store.listRecent(10).map((session) => session.id)).toEqual(['real']);
      const persisted = JSON.parse(readFileSync(join(micaHome, 'session-index.json'), 'utf-8')) as {
        rejects?: { id: string }[];
      };
      expect(persisted.rejects?.map((reject) => reject.id).sort()).toEqual(['legacy-array', 'legacy-object']);

      // 之后每存一个新会话都会改 sessions/ 的 mtime，但索引已经能对上磁盘，
      // 所以不能再重新解析目录（旧文件不在索引里就是永久失配，等于每次全量重扫）。
      const rebuild = vi.spyOn(SessionStore.prototype as unknown as { rebuildIndex: () => unknown }, 'rebuildIndex');
      const fresh = new SessionStore();
      fresh.save(makeSession('next', '/tmp/next', '2026-01-03T00:00:00.000Z'));
      expect(new SessionStore().listRecent(10).map((session) => session.id)).toEqual(['next', 'real']);
      expect(rebuild).not.toHaveBeenCalled();
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });
});

describe('SessionStore junk session cleanup', () => {
  it('removes empty Untitled sessions that never carried a conversation', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-junk-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();
      store.save(makeSession('real', '/tmp/real', '2026-01-01T00:00:00.000Z'));

      const junkId = 'junk-completed';
      const junkPath = join(SESSION_DIR, `${junkId}.json`);
      writeFileSync(junkPath, JSON.stringify(junkSession(junkId, 'completed')), 'utf-8');

      // A stale index cannot account for the extra file, so the rebuild drops
      // the empty completed session and hides it from the listing.
      expect(store.listRecent(10).map((session) => session.id)).toEqual(['real']);
      expect(existsSync(junkPath)).toBe(false);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('lists an interrupted running session so a crashed turn stays recoverable', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-junk-running-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();
      store.save(makeSession('real', '/tmp/real', '2026-01-01T00:00:00.000Z'));

      const runningPath = join(SESSION_DIR, 'junk-running.json');
      writeFileSync(runningPath, JSON.stringify(junkSession('junk-running', 'running')), 'utf-8');

      // `running` marks a turn that was in flight when the process went away.
      // Hiding it would make the session look lost after an unexpected
      // termination, which is exactly the case the user must be able to find
      // in /resume (rendered as `（uncompleted）`).
      expect(
        store
          .listRecent(10)
          .map((session) => session.id)
          .sort(),
      ).toEqual(['junk-running', 'real']);
      expect(existsSync(runningPath)).toBe(true);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('lists a session whose stored title is still the placeholder but which has content', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-junk-title-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();
      mkdirSync(SESSION_DIR, { recursive: true });

      // A crash can land before the title is re-derived from the prompt; the
      // placeholder title alone must never hide a session that holds a
      // conversation (the deletion rule already spares it).
      for (const [id, turnState] of [
        ['placeholder-with-conversation', 'completed'],
        ['placeholder-usage-only', 'completed'],
      ] as const) {
        writeFileSync(join(SESSION_DIR, `${id}.json`), JSON.stringify(placeholderSession(id, turnState)), 'utf-8');
      }

      const listed = store
        .listRecent(10)
        .map((session) => session.id)
        .sort();
      expect(listed).toEqual(['placeholder-usage-only', 'placeholder-with-conversation']);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('rebuilds an index written before the junk rule honoured conversation content', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-index-legacy-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();
      mkdirSync(SESSION_DIR, { recursive: true });
      writeFileSync(
        join(SESSION_DIR, 'placeholder-with-conversation.json'),
        JSON.stringify(placeholderSession('placeholder-with-conversation', 'running')),
        'utf-8',
      );
      // Legacy index entry: same id, but without the content flags the current
      // junk rule needs. Treating its missing flags as "no content" would hide
      // a real session, so the entry must be rejected and rebuilt instead.
      writeFileSync(
        join(micaHome, 'session-index.json'),
        JSON.stringify({
          version: 1,
          sessions: [
            {
              id: 'placeholder-with-conversation',
              title: 'Untitled session',
              updatedAt: '2026-01-01T00:00:00.000Z',
              cwd: '/tmp',
              providerId: 'test',
              model: 'test-model',
              uncompleted: true,
              turnState: 'running',
            },
          ],
        }),
        'utf-8',
      );

      expect(store.listRecent(10).map((session) => session.id)).toEqual(['placeholder-with-conversation']);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });
});

function makeSession(id: string, cwd: string, updatedAt: string): PersistedSession {
  return {
    version: 1,
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    cwd,
    turnState: 'completed',
    snapshot: {
      providerId: 'test',
      protocol: 'openai_chat_completions',
      model: 'test-model',
      effort: 'none',
      role: 'default',
      messages: [],
      conversationMessages: [],
      usageHistory: [],
      lastUsage: undefined,
    },
  };
}

function junkSession(id: string, turnState: 'running' | 'completed'): PersistedSession {
  return {
    version: 1,
    id,
    title: 'Untitled session',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    turnState,
    snapshot: {
      providerId: 'test',
      protocol: 'openai_chat_completions',
      model: 'test-model',
      effort: 'none',
      role: 'default',
      messages: [],
      conversationMessages: [],
      usageHistory: [],
      lastUsage: undefined,
    },
  };
}

/** A placeholder-titled session that already carries real content: a real user
 *  message (`placeholder-with-conversation`) or model usage
 *  (`placeholder-usage-only`). */
function placeholderSession(id: string, turnState: 'running' | 'completed'): PersistedSession {
  const withConversation = id === 'placeholder-with-conversation';
  return {
    version: 1,
    id,
    title: 'Untitled session',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    turnState,
    snapshot: {
      providerId: 'test',
      protocol: 'openai_chat_completions',
      model: 'test-model',
      effort: 'none',
      role: 'default',
      messages: withConversation ? [{ role: 'user', content: 'hello' }] : [],
      conversationMessages: withConversation ? [{ role: 'user', content: 'hello' }] : [],
      usageHistory: withConversation
        ? []
        : [
            {
              provider: 'openai_chat_completions',
              turnId: 1,
              requestIndex: 0,
              messageCount: 1,
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 5,
              totalTokens: 15,
              paidTokenRate: 1,
            },
          ],
      lastUsage: undefined,
    },
  };
}
