import { createHash } from 'node:crypto';

/**
 * 两侧共用的 cookie 形状。
 *
 * 刻意只留「同步判断需要的那几项」：值、过期、作用域与安全标志。`priority` / `source_scheme`
 * 这类只有 Chrome 关心的派生字段由 Chrome 侧自己按现有行保留，不进同步比较——否则任何一侧
 * 的内部字段一变（Chrome 升级改个枚举），整站 cookie 都会被判成「变了」。
 */
export type SameSite = 'unspecified' | 'no_restriction' | 'lax' | 'strict';

export type SyncCookie = {
  /** 域名，不带前导点。`.example.com` 与 `example.com` 是同一条 cookie 的两种写法。 */
  host: string;
  /** true = 只对这一台主机有效（Chrome 的 host_key 没有前导点）。 */
  hostOnly: boolean;
  name: string;
  path: string;
  value: string;
  /** unix 秒；null 表示会话 cookie（关掉浏览器就没了）。 */
  expiresAt: number | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
};

export const SAME_SITE_NAMES: SameSite[] = ['unspecified', 'no_restriction', 'lax', 'strict'];

/** Chrome 的 samesite 列：-1 未声明、0 no_restriction、1 lax、2 strict。 */
const CHROME_SAME_SITE: Record<number, SameSite> = {
  [-1]: 'unspecified',
  0: 'no_restriction',
  1: 'lax',
  2: 'strict'
};

export function sameSiteFromChrome(value: unknown): SameSite {
  const numeric = Number(value);
  return CHROME_SAME_SITE[Number.isFinite(numeric) ? numeric : -1] ?? 'unspecified';
}

export function sameSiteToChrome(value: SameSite): number {
  switch (value) {
    case 'no_restriction':
      return 0;
    case 'lax':
      return 1;
    case 'strict':
      return 2;
    default:
      return -1;
  }
}

export function sameSiteFromName(value: unknown): SameSite {
  const text = String(value || '');
  return (SAME_SITE_NAMES as string[]).includes(text) ? (text as SameSite) : 'unspecified';
}

/** 一条 cookie 的身份：Chrome 的唯一索引就是这三项。 */
export function cookieKey(cookie: { host: string; path?: string; name: string }): string {
  return `${cookie.host}\u0000${cookie.path || '/'}\u0000${cookie.name}`;
}

/**
 * 内容指纹：只存哈希不存值。
 *
 * 基线文件要回答的是「这条 cookie 上次同步时两边是不是一样的」，用不着原文；存了原文等于
 * 把用户所有站点的登录凭证抄了一份到插件数据目录里。
 */
export function cookieFingerprint(cookie: SyncCookie): string {
  const material = [
    cookie.value,
    cookie.expiresAt === null ? '' : String(Math.round(cookie.expiresAt)),
    cookie.secure ? '1' : '0',
    cookie.httpOnly ? '1' : '0',
    cookie.sameSite,
    cookie.hostOnly ? '1' : '0'
  ].join('\u0001');
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16);
}

/** 域写法归一：`Example.COM` / `.example.com` 都是 `example.com`。 */
export function normalizeHost(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/^\.+/, '')
    .toLowerCase();
}

/** 受控浏览器（Electron）返回的那一条 → 同步形状。 */
export function fromMicaCookie(input: {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  secure?: unknown;
  httpOnly?: unknown;
  session?: unknown;
  sameSite?: unknown;
  hostOnly?: unknown;
  expirationDate?: unknown;
}): SyncCookie | null {
  const name = String(input?.name ?? '');
  const host = normalizeHost(input?.domain);
  if (!name || !host) return null;
  const expiration = Number(input?.expirationDate);
  return {
    host,
    // 受控浏览器给的是 Electron 的 hostOnly；没有这个字段时按 domain 有没有前导点判断
    hostOnly: input?.hostOnly === undefined ? !String(input?.domain || '').startsWith('.') : Boolean(input.hostOnly),
    name,
    path: String(input?.path || '/') || '/',
    value: String(input?.value ?? ''),
    expiresAt: input?.session || !Number.isFinite(expiration) || expiration <= 0 ? null : expiration,
    secure: Boolean(input?.secure),
    httpOnly: Boolean(input?.httpOnly),
    sameSite: sameSiteFromName(input?.sameSite)
  };
}

/** 同步形状 → 写进受控浏览器的入参。 */
export function toMicaPayload(cookie: SyncCookie): Record<string, unknown> {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.hostOnly ? cookie.host : `.${cookie.host}`,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    hostOnly: cookie.hostOnly,
    sameSite: cookie.sameSite,
    ...(cookie.expiresAt === null ? {} : { expirationDate: cookie.expiresAt })
  };
}

/** 这一条是不是落在给定的域名范围内（含子域）。空范围 = 全都算。 */
export function hostMatches(host: string, scope: string): boolean {
  const wanted = normalizeHost(scope);
  if (!wanted) return true;
  const target = normalizeHost(host);
  return target === wanted || target.endsWith(`.${wanted}`);
}
