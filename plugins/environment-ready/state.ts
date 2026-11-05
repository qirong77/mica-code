import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export const TARGET_LIMIT = 6;
export const FRESHNESS_MS = 60_000;
export type Target = { id: string; label: string } & (
  | { kind: 'http'; url: string }
  | { kind: 'tcp'; host: string; port: number }
);
export type ProbeStatus = {
  checkedAt: number;
  reachable: boolean;
  /** HTTP 2xx only; null for TCP and transport failures. Never business health. */
  healthy: boolean | null;
  statusCode?: number;
  error?: 'timeout' | 'aborted' | 'connection' | 'redirect';
};
export type EnvironmentState = {
  version: 1;
  revision: string;
  targets: Target[];
  statuses: Record<string, ProbeStatus>;
  dismissedRevision?: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** No DNS lookup: localhost is pinned to a numeric loopback address. */
export function localHost(value: unknown): string {
  if (typeof value !== 'string') throw new Error('host 必须是本机回环地址');
  const host = value
    .toLowerCase()
    .trim()
    .replace(/^\[([^\]]+)\]$/, '$1');
  if (host === 'localhost') return '127.0.0.1';
  if (host === '::1' || (isIP(host) === 4 && host.split('.')[0] === '127')) return host;
  throw new Error('首版只支持 localhost、127.0.0.0/8 或 ::1；不支持远程地址');
}

export function parseTarget(value: unknown): Target {
  const raw = record(value);
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id))
    throw new Error('target.id 需要 1–64 位小写字母、数字、点、下划线或短横线');
  if (!label || label.length > 80 || /[\r\n\x00-\x1f]/.test(label))
    throw new Error('target.label 需要 1–80 位单行文字');
  if (raw.kind === 'http') {
    if (typeof raw.url !== 'string' || raw.url.length > 2048) throw new Error('HTTP 目标需要 http(s) URL');
    let url: URL;
    try {
      url = new URL(raw.url);
    } catch {
      throw new Error('HTTP 目标 URL 无效');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持 http(s) URL');
    if (url.username || url.password || /^[a-z]+:\/\/[^/]*@/i.test(raw.url)) throw new Error('URL 不得包含凭证');
    const host = localHost(url.hostname);
    url.hostname = host === '::1' ? '[::1]' : host;
    url.hash = '';
    return { id, label, kind: 'http', url: url.href };
  }
  if (raw.kind === 'tcp') {
    const host = localHost(raw.host);
    if (typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) {
      throw new Error('TCP port 必须是 1–65535 的整数');
    }
    return { id, label, kind: 'tcp', host, port: raw.port };
  }
  throw new Error('target.kind 只能是 http 或 tcp');
}

export function parseTargets(value: unknown): Target[] {
  if (!Array.isArray(value) || value.length > TARGET_LIMIT)
    throw new Error(`targets 需要数组，最多 ${TARGET_LIMIT} 个当前任务目标`);
  const targets = value.map(parseTarget);
  if (new Set(targets.map((target) => target.id)).size !== targets.length) throw new Error('target.id 不可重复');
  return targets;
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

/** Restored input is untrusted. Bad rows are dropped, never probed. */
export function normalizeState(value: unknown): EnvironmentState {
  const raw = record(value);
  const targets: Target[] = [];
  if (raw.version === 1 && Array.isArray(raw.targets)) {
    for (const item of raw.targets) {
      try {
        const target = parseTarget(item);
        if (targets.length < TARGET_LIMIT && !targets.some((entry) => entry.id === target.id)) targets.push(target);
      } catch {
        /* Invalid saved targets must never reach the network. */
      }
    }
  }
  const revision =
    typeof raw.revision === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(raw.revision)
      ? raw.revision
      : fingerprint(targets);
  const statuses: Record<string, ProbeStatus> = {};
  for (const target of targets) {
    const status = record(record(raw.statuses)[target.id]);
    if (typeof status.checkedAt !== 'number' || !Number.isFinite(status.checkedAt) || status.checkedAt <= 0) continue;
    if (typeof status.reachable !== 'boolean') continue;
    const statusCode =
      typeof status.statusCode === 'number' &&
      Number.isInteger(status.statusCode) &&
      status.statusCode >= 100 &&
      status.statusCode <= 599
        ? status.statusCode
        : undefined;
    const error = ['timeout', 'aborted', 'connection', 'redirect'].includes(String(status.error))
      ? (status.error as ProbeStatus['error'])
      : undefined;
    statuses[target.id] = {
      checkedAt: status.checkedAt,
      reachable: status.reachable,
      healthy:
        target.kind === 'http' && status.reachable && statusCode !== undefined
          ? statusCode >= 200 && statusCode < 300
          : null,
      ...(statusCode === undefined ? {} : { statusCode }),
      ...(error ? { error } : {}),
    };
  }
  return {
    version: 1,
    revision,
    targets,
    statuses,
    ...(raw.dismissedRevision === revision ? { dismissedRevision: revision } : {}),
  };
}

export function intervalMs(value: unknown): number {
  const seconds = typeof value === 'string' && value.trim() ? Number(value) : 30;
  return Math.min(300, Math.max(10, Number.isFinite(seconds) ? seconds : 30)) * 1000;
}

export function address(target: Target): string {
  return target.kind === 'http' ? target.url : `${target.host === '::1' ? '[::1]' : target.host}:${target.port}`;
}
