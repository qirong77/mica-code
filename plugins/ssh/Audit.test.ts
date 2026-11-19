import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { appendAudit, AUDIT_FILE, AUDIT_LOCK, auditFailureCount, readAudit, type AuditEntry } from './Audit.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mica-ssh-audit-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const entry: AuditEntry = {
  at: '2026-11-19T00:00:00Z',
  hostId: 'test',
  target: 'root@example.invalid:22',
  source: 'run',
  script: '',
  exitCode: 0,
  durationMs: 10,
  ok: true,
};
const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

describe('SSH private audit', () => {
  it.each(['\n', '\r\n', '\r', '\u2028'])(
    'hashes only the first physical line (%j), never raw command/notes/extra fields',
    (newline) => {
      const first = 'curl -H "Authorization: Bearer FIRST_LINE_SECRET" https://example.invalid';
      appendAudit(dir, {
        ...entry,
        script: `${first}${newline}export TOKEN=MULTILINE_SECRET`,
        note: 'connection error\nRAW_ERROR_SECRET',
        logPath: '/tmp/mica-ssh-1.log\nPATH_SECRET',
        unexpected: 'EXTRA_FIELD_SECRET',
      } as AuditEntry);
      const raw = readFileSync(join(dir, AUDIT_FILE), 'utf8');
      expect(raw).not.toMatch(/FIRST_LINE_SECRET|MULTILINE_SECRET|RAW_ERROR_SECRET|PATH_SECRET|EXTRA_FIELD_SECRET/);
      expect(JSON.parse(raw)).toMatchObject({
        schemaVersion: 2,
        script: digest(first),
        note: 'diagnostic_omitted',
        ok: true,
      });
      expect(JSON.parse(raw).logPath).toBeUndefined();
      expect(statSync(join(dir, AUDIT_FILE)).mode & 0o777).toBe(0o600);
      expect(readAudit(dir)[0]?.script).toBe(digest(first));
    },
  );

  it('tightens existing permissions before append and preserves safe fixed codes and generated log paths', () => {
    const file = join(dir, AUDIT_FILE);
    writeFileSync(file, '', { mode: 0o644 });
    chmodSync(file, 0o644);
    appendAudit(dir, {
      ...entry,
      script: 'echo safe',
      note: 'session_dead',
      logPath: '/tmp/mica-ssh-20261119-abc123.log',
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readAudit(dir)[0]).toMatchObject({ note: 'session_dead', logPath: '/tmp/mica-ssh-20261119-abc123.log' });
  });

  it('keeps at most 200 current entries atomically, invalidates cached counts and drops unknown fields', () => {
    const file = join(dir, AUDIT_FILE);
    appendAudit(dir, { ...entry, script: 'cache initial count' });
    writeFileSync(
      file,
      `${Array.from({ length: 201 }, () => JSON.stringify({ ...entry, schemaVersion: 2, script: digest('echo old'), note: 'session_dead', unexpected: 'EXTRA_FIELD_SECRET' })).join('\n')}\n`,
    );
    appendAudit(dir, { ...entry, script: 'echo new' });
    const raw = readFileSync(file, 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(200);
    expect(raw).not.toMatch(/EXTRA_FIELD_SECRET/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readAudit(dir, 500)).toHaveLength(200);
    expect(readAudit(dir, 500)[0]?.script).toBe(digest('echo new'));
  });

  it('rejects old records without interpreting or modifying their bytes during a read', () => {
    const file = join(dir, AUDIT_FILE);
    const raw = `${JSON.stringify({ ...entry, script: 'echo OLD_SECRET', note: 'RAW_OLD_NOTE' })}\n`;
    writeFileSync(file, raw);
    expect(readAudit(dir)).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(raw);
  });

  it.each([
    { schemaVersion: 1, script: digest('old') },
    { schemaVersion: 2, script: 'echo RAW_SECRET' },
    { schemaVersion: 2, script: digest('old'), note: 'RAW_NOTE_SECRET' },
    { schemaVersion: 2, script: digest('old'), logPath: '/unsafe/RAW_PATH_SECRET' },
    { schemaVersion: 2, script: digest('old'), at: 'not a timestamp' },
  ])('does not reinterpret an invalid explicit stored record: %j', (invalid) => {
    const file = join(dir, AUDIT_FILE);
    const raw = JSON.stringify({ ...entry, ...invalid });
    writeFileSync(file, raw);
    expect(readAudit(dir)).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(raw);
  });

  it('does not maintain unsupported history as though it were current; Evolution must archive it first', () => {
    const file = join(dir, AUDIT_FILE);
    const original = `${Array.from({ length: 201 }, () => JSON.stringify({ ...entry, script: 'echo LEGACY_SECRET' })).join('\n')}\n`;
    writeFileSync(file, original);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = auditFailureCount();
    try {
      appendAudit(dir, { ...entry, script: 'echo current' });
      expect(readFileSync(file, 'utf8').startsWith(original)).toBe(true);
      expect(readAudit(dir)).toHaveLength(1);
      expect(readAudit(dir)[0]?.schemaVersion).toBe(2);
      expect(auditFailureCount()).toBe(before + 1);
      expect(warning).toHaveBeenCalledExactlyOnceWith('ssh.audit_write_failed');
    } finally {
      warning.mockRestore();
    }
  });

  it('uses the migration lock, counts busy failures, and never writes over another holder', () => {
    appendAudit(dir, { ...entry, script: 'first' });
    const file = join(dir, AUDIT_FILE);
    const original = readFileSync(file, 'utf8');
    const release = acquireProcessLock(join(dir, AUDIT_LOCK))!;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = auditFailureCount();
    try {
      appendAudit(dir, { ...entry, script: 'BUSY_SECRET' });
      expect(readFileSync(file, 'utf8')).toBe(original);
      expect(auditFailureCount()).toBe(before + 1);
      expect(warning).toHaveBeenCalledExactlyOnceWith('ssh.audit_write_failed');
    } finally {
      release();
      warning.mockRestore();
    }
    appendAudit(dir, { ...entry, script: 'after release' });
    expect(readAudit(dir)).toHaveLength(2);
  });

  it('preserves the last complete record when the existing stream has no terminal newline', () => {
    appendAudit(dir, { ...entry, script: 'first' });
    const file = join(dir, AUDIT_FILE);
    writeFileSync(file, readFileSync(file, 'utf8').trimEnd());
    appendAudit(dir, { ...entry, script: 'second' });
    expect(readAudit(dir).map((row) => row.script)).toEqual([digest('second'), digest('first')]);
    expect(readAudit(dir, 0)).toEqual([]);
    expect(readAudit(dir, -1)).toEqual([]);
  });

  it('contains audit filesystem failures and emits only the fixed diagnostic', () => {
    mkdirSync(join(dir, AUDIT_FILE));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = auditFailureCount();
    try {
      expect(() => appendAudit(dir, { ...entry, script: 'SECRET_MUST_NOT_APPEAR' })).not.toThrow();
      expect(auditFailureCount()).toBe(before + 1);
      expect(warning).toHaveBeenCalledExactlyOnceWith('ssh.audit_write_failed');
    } finally {
      warning.mockRestore();
    }
  });
});
