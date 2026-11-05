import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveSafeStorageKey } from './cookieCodec.js';
import { applyChromeWrite, buildWriteScript, readChromeCookies, readCookieColumns } from './cookiesDb.js';
import { execScript, queryRows, sqlText } from './sqlite.js';
import type { SyncCookie } from '../cookies.js';

/**
 * 真的建一个 Chrome 形态的 cookie 库再读写一遍：加密、列裁剪、事务、删除全都走真 sqlite3。
 * 这台机器上没有 Chrome 数据（要全磁盘访问），但库的形态可以就地造出来。
 */
const sqliteAvailable = spawnSync('sqlite3', ['--version'], { encoding: 'utf8' }).status === 0;
const KEY = deriveSafeStorageKey('test-secret');

/** 与 Chrome 的 schema 足够接近：唯一索引一样，另外带上几个新版本才有的列。 */
const SCHEMA = `
CREATE TABLE meta (key TEXT NOT NULL UNIQUE PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE cookies (
  creation_utc INTEGER NOT NULL,
  host_key TEXT NOT NULL,
  top_frame_site_key TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  encrypted_value BLOB NOT NULL DEFAULT X'',
  path TEXT NOT NULL,
  expires_utc INTEGER NOT NULL,
  is_secure INTEGER NOT NULL DEFAULT 0,
  is_httponly INTEGER NOT NULL DEFAULT 0,
  last_access_utc INTEGER NOT NULL,
  has_expires INTEGER NOT NULL DEFAULT 1,
  is_persistent INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 1,
  samesite INTEGER NOT NULL DEFAULT -1,
  source_scheme INTEGER NOT NULL DEFAULT 0,
  source_port INTEGER NOT NULL DEFAULT -1,
  last_update_utc INTEGER NOT NULL,
  source_type INTEGER NOT NULL DEFAULT 0,
  has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, name, path);
INSERT INTO meta (key, value) VALUES ('version', '24');
`;

const cookie = (patch: Partial<SyncCookie> = {}): SyncCookie => ({
  host: 'example.com',
  hostOnly: true,
  name: 'sid',
  path: '/',
  value: 'value-1',
  expiresAt: 1_767_225_600,
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
  ...patch
});

let dir = '';
let db = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mica-cookie-db-'));
  db = join(dir, 'Cookies');
  execScript(db, SCHEMA);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.runIf(sqliteAvailable)('chrome cookie database', () => {
  it('reads an empty database as an empty cookie list', () => {
    expect(readChromeCookies({ dbPath: db, key: KEY })).toEqual({ cookies: [], unreadable: 0 });
  });

  it('writes a cookie in Chrome’s encrypted form and reads it back', () => {
    applyChromeWrite(db, { upsert: [cookie()], remove: [] }, { key: KEY, nowSeconds: 1_700_000_000 });
    const { cookies, unreadable } = readChromeCookies({ dbPath: db, key: KEY });
    expect(unreadable).toBe(0);
    expect(cookies).toEqual([
      {
        host: 'example.com',
        hostOnly: true,
        name: 'sid',
        path: '/',
        value: 'value-1',
        expiresAt: 1_767_225_600,
        secure: true,
        httpOnly: true,
        sameSite: 'lax'
      }
    ]);

    // 库里的明文列是空的，值只以密文存在
    const rows = queryRows<{ value: string; encrypted: string; meta_version: string }>(
      db,
      "SELECT value, hex(encrypted_value) AS encrypted, (SELECT value FROM meta WHERE key='version') AS meta_version FROM cookies"
    );
    expect(rows[0]?.value).toBe('');
    expect(rows[0]?.encrypted.startsWith('763130')).toBe(true); // "v10"
    expect(rows[0]?.meta_version).toBe('24');
  });

  it('keeps domain cookies as domain cookies and session cookies without an expiry', () => {
    applyChromeWrite(
      db,
      {
        upsert: [cookie({ hostOnly: false, name: 'wide' }), cookie({ name: 'session', expiresAt: null })],
        remove: []
      },
      { key: KEY, nowSeconds: 1_700_000_000 }
    );
    const hosts = queryRows<{ host_key: string }>(db, 'SELECT host_key FROM cookies ORDER BY name');
    expect(hosts.map((row) => row.host_key)).toEqual(['example.com', '.example.com']);
    const { cookies } = readChromeCookies({ dbPath: db, key: KEY });
    expect(cookies.find((entry) => entry.name === 'session')?.expiresAt).toBeNull();
    expect(cookies.find((entry) => entry.name === 'wide')?.hostOnly).toBe(false);
  });

  it('updates an existing row in place: same creation time, new value, no duplicate', () => {
    applyChromeWrite(db, { upsert: [cookie()], remove: [] }, { key: KEY, nowSeconds: 1_600_000_000 });
    const before = queryRows<{ creation_utc: number }>(db, 'SELECT creation_utc FROM cookies');
    applyChromeWrite(
      db,
      { upsert: [cookie({ value: 'value-2', secure: false })], remove: [] },
      { key: KEY, nowSeconds: 1_700_000_000 }
    );
    const rows = queryRows<{ creation_utc: number; is_secure: number; n: number }>(
      db,
      'SELECT creation_utc, is_secure, (SELECT count(*) FROM cookies) AS n FROM cookies'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.creation_utc).toBe(before[0]?.creation_utc);
    expect(rows[0]?.is_secure).toBe(0);
    expect(readChromeCookies({ dbPath: db, key: KEY }).cookies[0]?.value).toBe('value-2');
  });

  it('removes a cookie only from the requested path', () => {
    applyChromeWrite(
      db,
      { upsert: [cookie(), cookie({ path: '/admin', value: 'admin-value' })], remove: [] },
      { key: KEY }
    );
    applyChromeWrite(db, { upsert: [], remove: [{ host: 'example.com', name: 'sid', path: '/admin' }] }, { key: KEY });
    const left = readChromeCookies({ dbPath: db, key: KEY }).cookies;
    expect(left.map((entry) => entry.path)).toEqual(['/']);
  });

  it('counts cookies it cannot decrypt instead of pretending they are empty', () => {
    applyChromeWrite(db, { upsert: [cookie()], remove: [] }, { key: KEY });
    const wrongKey = deriveSafeStorageKey('another-secret');
    const result = readChromeCookies({ dbPath: db, key: wrongKey });
    expect(result.unreadable).toBe(1);
    expect(result.cookies[0]).toMatchObject({ name: 'sid', value: '' });
  });

  it('survives a database that lacks the newer columns', () => {
    const oldDb = join(dir, 'OldCookies');
    execScript(
      oldDb,
      `CREATE TABLE cookies (creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, name TEXT NOT NULL,
        value TEXT NOT NULL, encrypted_value BLOB NOT NULL DEFAULT X'', path TEXT NOT NULL,
        expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL DEFAULT 0, is_httponly INTEGER NOT NULL DEFAULT 0,
        last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL DEFAULT 1,
        is_persistent INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 1,
        samesite INTEGER NOT NULL DEFAULT -1, source_scheme INTEGER NOT NULL DEFAULT 0,
        source_port INTEGER NOT NULL DEFAULT -1, last_update_utc INTEGER NOT NULL);
       CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, name, path);`
    );
    const columns = readCookieColumns(oldDb);
    expect(columns.has('source_type')).toBe(false);
    applyChromeWrite(oldDb, { upsert: [cookie()], remove: [] }, { key: KEY });
    expect(readChromeCookies({ dbPath: oldDb, key: KEY }).cookies[0]?.value).toBe('value-1');
  });

  it('quotes names and paths instead of breaking the statement', () => {
    const tricky = cookie({ name: "it's", path: "/a'b" });
    applyChromeWrite(db, { upsert: [tricky], remove: [] }, { key: KEY });
    expect(readChromeCookies({ dbPath: db, key: KEY }).cookies[0]).toMatchObject({
      name: "it's",
      path: "/a'b"
    });
  });
});

describe('write script', () => {
  it('only touches columns the database actually has', () => {
    const script = buildWriteScript(
      { upsert: [cookie()], remove: [] },
      { columns: new Set(['host_key', 'name', 'value', 'encrypted_value', 'path', 'expires_utc', 'is_secure', 'is_httponly', 'has_expires', 'is_persistent', 'samesite', 'creation_utc']), key: KEY, nowSeconds: 1_700_000_000 }
    );
    expect(script).toContain('INSERT INTO cookies');
    expect(script).toContain('ON CONFLICT(host_key, name, path) DO UPDATE SET');
    expect(script).not.toContain('source_type');
    expect(script).not.toContain('has_cross_site_ancestor');
  });

  it('deletes both the host-only and the dot-domain spelling of a host', () => {
    const script = buildWriteScript(
      { upsert: [], remove: [{ host: 'example.com', name: 'sid', path: '/' }] },
      { columns: new Set(['host_key']), key: KEY }
    );
    expect(script).toContain(`host_key IN ('example.com', '.example.com')`);
    expect(script).toContain(`name='sid'`);
  });

  it('escapes quotes in text literals', () => {
    expect(sqlText("o'brien")).toBe("'o''brien'");
  });
});
