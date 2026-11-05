import {
  chromeTimeToUnixSeconds,
  decryptCookieValue,
  encryptCookieValue,
  unixSecondsToChromeTime
} from './cookieCodec.js';
import { execScript, queryRows, sqlBlob, sqlText, type SqliteRunner } from './sqlite.js';
import { normalizeHost, sameSiteFromChrome, sameSiteToChrome, type SyncCookie } from '../cookies.js';

/**
 * Chrome 的 `cookies` 表。**只碰确认存在的列**（先 `PRAGMA table_info`）：这个库的列会随
 * Chrome 升级增加，写死一整串在旧版本上会直接报「no such column」，在新版本上又会漏掉
 * 该给默认值的那几列。
 */

const READ_COLUMNS = [
  'host_key',
  'name',
  'path',
  'value',
  'hex(encrypted_value) AS encrypted_hex',
  'expires_utc',
  'is_secure',
  'is_httponly',
  'has_expires',
  'samesite'
] as const;

/** 写的时候要给值的列（插入时）；更新时只改内容相关的几列。 */
const META_COLUMNS: Record<string, (cookie: SyncCookie, nowSeconds: number) => string> = {
  creation_utc: (_cookie, nowSeconds) => String(unixSecondsToChromeTime(nowSeconds)),
  last_access_utc: (_cookie, nowSeconds) => String(unixSecondsToChromeTime(nowSeconds)),
  last_update_utc: (_cookie, nowSeconds) => String(unixSecondsToChromeTime(nowSeconds)),
  top_frame_site_key: () => sqlText(''),
  source_scheme: (cookie) => String(cookie.secure ? 2 : 1),
  source_port: () => '-1',
  source_type: () => '0',
  has_cross_site_ancestor: () => '0',
  priority: () => '1'
};

export type ChromeTableColumns = {
  name: string;
};

export function readCookieColumns(
  dbPath: string,
  { run }: { run?: SqliteRunner } = {}
): Set<string> {
  const rows = queryRows<{ name: string }>(dbPath, 'PRAGMA table_info(cookies)', { ...(run ? { run } : {}) });
  return new Set(rows.map((row) => String(row.name)));
}

/**
 * 读出整个库。
 *
 * 解不开的那条（换了密钥、条目是别的 profile 写的）保留 name/path 但值留空并记进
 * `unreadable`：直接丢掉会让同步把它当成「Chrome 里没有这条」而删掉 Mica 那边。
 */
export type ReadChromeResult = {
  cookies: SyncCookie[];
  unreadable: number;
};

export function readChromeCookies({
  dbPath,
  key,
  run
}: {
  dbPath: string;
  key: Buffer;
  run?: SqliteRunner;
}): ReadChromeResult {
  const rows = queryRows<Record<string, unknown>>(
    dbPath,
    `SELECT ${READ_COLUMNS.join(', ')} FROM cookies`,
    run ? { run } : {}
  );
  const cookies: SyncCookie[] = [];
  let unreadable = 0;
  for (const row of rows) {
    const hostKey = String(row.host_key ?? '');
    const host = normalizeHost(hostKey);
    const name = String(row.name ?? '');
    if (!host || !name) continue;
    const encryptedHex = String(row.encrypted_hex ?? '').trim();
    let value = String(row.value ?? '');
    if (encryptedHex) {
      const decrypted = decryptCookieValue(Buffer.from(encryptedHex, 'hex'), hostKey, key);
      if (decrypted === null) {
        unreadable += 1;
        value = '';
      } else {
        value = decrypted;
      }
    }
    const expiresAt =
      Number(row.has_expires ?? 1) === 0 ? null : chromeTimeToUnixSeconds(row.expires_utc);
    cookies.push({
      host,
      hostOnly: !hostKey.startsWith('.'),
      name,
      path: String(row.path || '/') || '/',
      value,
      expiresAt,
      secure: Number(row.is_secure ?? 0) !== 0,
      httpOnly: Number(row.is_httponly ?? 0) !== 0,
      sameSite: sameSiteFromChrome(row.samesite)
    });
  }
  return { cookies, unreadable };
}

export type ChromeWritePlan = {
  /** 要插入或覆盖的行。 */
  upsert: SyncCookie[];
  /** 要删掉的行。 */
  remove: { host: string; name: string; path: string }[];
};

/**
 * 把计划落成一个事务脚本。
 *
 * `ON CONFLICT(host_key, name, path)` 对得上 Chrome 自己的唯一索引；更新时**不动**
 * `creation_utc` 与 `priority` / `source_*` 这些我们没资格改的字段——它们属于 Chrome。
 */
export function buildWriteScript(
  plan: ChromeWritePlan,
  {
    columns,
    key,
    nowSeconds = Math.floor(Date.now() / 1000)
  }: { columns: Set<string>; key: Buffer; nowSeconds?: number }
): string {
  const statements: string[] = [];
  const has = (column: string) => columns.has(column);

  for (const cookie of plan.upsert) {
    const hostKey = cookie.hostOnly ? cookie.host : `.${cookie.host}`;
    const encrypted = encryptCookieValue(cookie.value, hostKey, key);
    const base: Record<string, string> = {
      host_key: sqlText(hostKey),
      name: sqlText(cookie.name),
      value: sqlText(''),
      encrypted_value: sqlBlob(encrypted),
      path: sqlText(cookie.path || '/'),
      expires_utc: String(
        cookie.expiresAt === null ? 0 : unixSecondsToChromeTime(cookie.expiresAt)
      ),
      is_secure: cookie.secure ? '1' : '0',
      is_httponly: cookie.httpOnly ? '1' : '0',
      has_expires: cookie.expiresAt === null ? '0' : '1',
      is_persistent: cookie.expiresAt === null ? '0' : '1',
      samesite: String(sameSiteToChrome(cookie.sameSite))
    };
    for (const [column, produce] of Object.entries(META_COLUMNS)) {
      if (has(column)) base[column] = produce(cookie, nowSeconds);
    }
    const writable = Object.keys(base).filter((column) => has(column));
    const updated = writable.filter(
      (column) => !['host_key', 'name', 'path', 'creation_utc', 'source_type'].includes(column)
    );
    statements.push(
      `INSERT INTO cookies (${writable.join(', ')}) VALUES (${writable
        .map((column) => base[column])
        .join(', ')}) ON CONFLICT(host_key, name, path) DO UPDATE SET ${updated
        .map((column) => `${column}=excluded.${column}`)
        .join(', ')};`
    );
  }

  for (const entry of plan.remove) {
    const hostKey = entry.host;
    statements.push(
      `DELETE FROM cookies WHERE host_key IN (${sqlText(hostKey)}, ${sqlText(
        `.${hostKey}`
      )}) AND name=${sqlText(entry.name)} AND path=${sqlText(entry.path || '/')};`
    );
  }
  return statements.join('\n');
}

export function applyChromeWrite(
  dbPath: string,
  plan: ChromeWritePlan,
  { key, run, nowSeconds }: { key: Buffer; run?: SqliteRunner; nowSeconds?: number }
): void {
  if (plan.upsert.length === 0 && plan.remove.length === 0) return;
  const columns = readCookieColumns(dbPath, run ? { run } : {});
  const script = buildWriteScript(plan, {
    columns,
    key,
    ...(nowSeconds === undefined ? {} : { nowSeconds })
  });
  execScript(dbPath, script, run ? { run } : {});
}
