import {
  appendFileSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { logger } from '@packages/mica-diagnostics/index.js';

/**
 * 审计日志：`$MICA_HOME/plugin-data/ssh/audit.jsonl`。
 *
 * 分布式系统里最贵的事故是「谁在什么时候改了什么」，而模型发起的命令最容易变成这种
 * 事故：它不会记得自己十分钟前 `rm` 过什么。这里尽力保存最近 200 条操作——主机、脚本首行哈希、
 * 退出码、耗时。**不记输出正文**（可能带凭据、可能几十 MB），只在输出被裁剪时记路径。
 *
 * 只追加、只保留最近 N 条：面板要翻的是「刚刚发生了什么」，不是归档。
 */

export const AUDIT_FILE = 'audit.jsonl';
export const AUDIT_LOCK = 'audit.lock';
const KEEP = 200;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const HASH = /^sha256:[a-f0-9]{64}$/;
const LOG_PATH = /^\/tmp\/mica-ssh-[a-zA-Z0-9._-]+\.log$/;
const SAFE_NOTES = new Set(['session_dead', 'command_superseded_completion_unknown', 'diagnostic_omitted']);

export type AuditEntry = {
  at: string;
  hostId: string;
  target: string;
  source: 'run' | 'read' | 'session' | 'panel';
  /** 落盘只保留首个物理行的 SHA-256；不存命令正文或参数。 */
  script: string;
  exitCode: number | null;
  durationMs: number;
  ok: boolean;
  /** 输出被裁剪时远端完整日志的路径。 */
  logPath?: string;
  note?: string;
};

export type StoredAuditEntry = AuditEntry & { schemaVersion: 2 };

function scriptHash(value: string): string {
  if (HASH.test(value)) return value;
  const firstLine = value.split(/[\r\n\u0085\u2028\u2029]/, 1)[0] ?? '';
  return `sha256:${createHash('sha256').update(firstLine).digest('hex')}`;
}

function safeEntry(entry: AuditEntry): StoredAuditEntry {
  // 构造白名单，不把未知附加字段或远端错误原文顺手序列化进去。
  return {
    schemaVersion: 2,
    at: entry.at,
    hostId: entry.hostId,
    target: entry.target,
    source: entry.source,
    script: scriptHash(entry.script),
    exitCode: entry.exitCode,
    durationMs: entry.durationMs,
    ok: entry.ok,
    ...(entry.logPath && LOG_PATH.test(entry.logPath) ? { logPath: entry.logPath } : {}),
    ...(entry.note ? { note: SAFE_NOTES.has(entry.note) ? entry.note : 'diagnostic_omitted' } : {}),
  };
}

function isAuditEntry(input: unknown): input is AuditEntry {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  return (
    typeof record.at === 'string' &&
    Number.isFinite(Date.parse(record.at)) &&
    typeof record.hostId === 'string' &&
    !!record.hostId &&
    typeof record.target === 'string' &&
    !!record.target &&
    ['run', 'read', 'session', 'panel'].includes(String(record.source)) &&
    typeof record.script === 'string' &&
    (record.exitCode === null || Number.isSafeInteger(record.exitCode)) &&
    typeof record.durationMs === 'number' &&
    Number.isFinite(record.durationMs) &&
    record.durationMs >= 0 &&
    typeof record.ok === 'boolean' &&
    (record.logPath === undefined || typeof record.logPath === 'string') &&
    (record.note === undefined || typeof record.note === 'string')
  );
}

/** 把生产者输入投影成当前记录；不是旧格式读取器。 */
export function projectAuditEntry(input: unknown): StoredAuditEntry | null {
  return isAuditEntry(input) ? safeEntry(input) : null;
}

/** 运行时只接受当前形态。 */
export function storedAuditEntry(input: unknown): StoredAuditEntry | null {
  if (
    !isAuditEntry(input) ||
    (input as StoredAuditEntry).schemaVersion !== 2 ||
    !HASH.test(input.script) ||
    (input.note !== undefined && !SAFE_NOTES.has(input.note)) ||
    (input.logPath !== undefined && !LOG_PATH.test(input.logPath))
  )
    return null;
  return safeEntry(input);
}

function readLines(fd: number): string[] {
  const info = fstatSync(fd);
  if (!info.isFile() || info.size > MAX_READ_BYTES) throw new Error('Audit read exceeds bounds');
  const buffer = Buffer.alloc(info.size + 1);
  let size = 0;
  while (size < buffer.length) {
    const count = readSync(fd, buffer, size, buffer.length - size, size);
    if (count === 0) break;
    size += count;
  }
  if (size > info.size || fstatSync(fd).size !== info.size) throw new Error('Audit changed during read');
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)).split('\n');
  if (lines.length > 50_001 || lines.some((line) => Buffer.byteLength(line) > 64 * 1024))
    throw new Error('Audit lines exceed bounds');
  return lines.filter((line) => line.trim());
}

function parseStored(line: string): StoredAuditEntry | null {
  try {
    return storedAuditEntry(JSON.parse(line));
  } catch {
    return null;
  }
}

// Avoid reading an unchanged, sub-limit audit on every local append. An external writer,
// rotation or migration invalidates this small count cache via the full file signature.
const lineCounts = new Map<string, { signature: string; count: number }>();
function signature(fd: number): string {
  const info = fstatSync(fd, { bigint: true });
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

let auditFailures = 0;
export function auditFailureCount(): number {
  return auditFailures;
}
function auditFailed(): void {
  auditFailures += 1;
  // Fixed message only: paths, commands and credentials must not leak into diagnostics.
  try {
    console.warn('ssh.audit_write_failed');
    logger('ssh-audit').warn('audit.write.failed', { failures: auditFailures });
  } catch {
    /* Diagnostics never affect remote work. */
  }
}

export function appendAudit(dataDir: string, entry: AuditEntry): void {
  const file = join(dataDir, AUDIT_FILE);
  let fd: number | undefined;
  let release: (() => void) | null = null;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    release = acquireProcessLock(join(dataDir, AUDIT_LOCK));
    if (!release) throw new Error('Audit writer busy');
    const stored = projectAuditEntry(entry);
    if (!stored) throw new Error('Invalid audit entry');
    fd = openSync(
      file,
      constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    // mode 只作用于新文件；已存在、权限过宽的审计文件也在追加前收紧。
    if ((fstatSync(fd).mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
    const cached = lineCounts.get(file);
    const count = cached?.signature === signature(fd) ? cached.count : readLines(fd).length;
    const size = fstatSync(fd).size;
    const last = Buffer.alloc(1);
    const separator = size && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 10 ? '\n' : '';
    appendFileSync(fd, `${separator}${JSON.stringify(stored)}\n`, 'utf8');
    const retained = count + 1;
    if (retained > KEEP) {
      trimAudit(file, fd);
      // trim atomically replaces the inode; do not cache the old descriptor.
      lineCounts.delete(file);
    } else {
      if (lineCounts.size >= 64) lineCounts.delete(lineCounts.keys().next().value!);
      lineCounts.set(file, { signature: signature(fd), count: retained });
    }
  } catch {
    lineCounts.delete(file);
    auditFailed();
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        auditFailed();
      }
    }
    release?.();
  }
}

/** Caller holds audit.lock. Unsupported lines are never silently rewritten or discarded. */
function trimAudit(file: string, fd: number): void {
  const lines = readLines(fd);
  if (lines.length <= KEEP) return;
  const entries = lines.map(parseStored);
  if (entries.some((entry) => !entry)) throw new Error('Old audit shape is no longer supported');
  const temporary = `${file}.${randomUUID()}.tmp`;
  let temporaryFd: number | undefined;
  let created = false;
  try {
    temporaryFd = openSync(temporary, 'wx', 0o600);
    created = true;
    writeFileSync(
      temporaryFd,
      `${entries
        .slice(-KEEP)
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
      'utf8',
    );
    fsyncSync(temporaryFd);
    closeSync(temporaryFd);
    temporaryFd = undefined;
    renameSync(temporary, file);
    created = false;
  } finally {
    if (temporaryFd !== undefined) closeSync(temporaryFd);
    if (created) unlinkSync(temporary);
  }
}

export function readAudit(dataDir: string, limit = 20): StoredAuditEntry[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  let fd: number | undefined;
  try {
    fd = openSync(join(dataDir, AUDIT_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return readLines(fd)
      .map(parseStored)
      .filter((entry): entry is StoredAuditEntry => entry !== null)
      .slice(-Math.min(limit, KEEP))
      .reverse();
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* read-only diagnostics remain best effort */
      }
    }
  }
}
