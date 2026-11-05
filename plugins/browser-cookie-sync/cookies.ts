export type SyncCookie = {
  host: string;
  hostOnly: boolean;
  name: string;
  path: string;
  value: string;
  expiresAt: number | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
};

export const SAME_SITE_NAMES: SyncCookie['sameSite'][] = ['unspecified', 'no_restriction', 'lax', 'strict'];

export function normalizeHost(value: unknown): string {
  return String(value || '').trim().replace(/^\.+/, '').toLowerCase();
}

export function fromMicaCookie(input: Record<string, unknown>): SyncCookie | null {
  if (typeof input.name !== 'string' || !input.name || typeof input.domain !== 'string' ||
    typeof input.value !== 'string') return null;
  const host = normalizeHost(input.domain);
  if (!host) return null;
  const expiresAt = Number(input.expirationDate);
  return {
    host,
    hostOnly: input.hostOnly === undefined ? !input.domain.startsWith('.') : Boolean(input.hostOnly),
    name: input.name,
    path: typeof input.path === 'string' ? input.path : '/',
    value: input.value,
    expiresAt: input.session || !Number.isFinite(expiresAt) || expiresAt <= 0 ? null : expiresAt,
    secure: Boolean(input.secure),
    httpOnly: Boolean(input.httpOnly),
    sameSite: SAME_SITE_NAMES.includes(input.sameSite as SyncCookie['sameSite'])
      ? input.sameSite as SyncCookie['sameSite'] : 'unspecified'
  };
}

export function toMicaPayload(cookie: SyncCookie): Record<string, unknown> {
  return {
    name: cookie.name, value: cookie.value, domain: cookie.hostOnly ? cookie.host : `.${cookie.host}`,
    path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
    hostOnly: cookie.hostOnly, sameSite: cookie.sameSite,
    ...(cookie.expiresAt === null ? {} : { expirationDate: cookie.expiresAt })
  };
}
