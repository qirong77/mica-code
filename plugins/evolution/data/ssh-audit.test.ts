import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { appendAudit, AUDIT_FILE, AUDIT_LOCK, readAudit, type AuditEntry } from '../../ssh/Audit.js';
import { DATA_MIGRATIONS } from './index.js';
import { sshAuditV2 } from './ssh-audit.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mica-ssh-audit-migration-'));
  homes.push(home);
  const root = join(home, 'plugin-data', 'ssh');
  mkdirSync(root, { recursive: true });
  return { home, root, file: join(root, AUDIT_FILE) };
}
const entry: AuditEntry = {
  at: '2026-11-17T12:34:56.789Z',
  hostId: 'test',
  target: 'root@example.invalid:22',
  source: 'run',
  script: 'echo FIRST_SECRET\nexport SECOND_SECRET=private',
  exitCode: 17,
  durationMs: 12.5,
  ok: false,
};
const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

it('registers the migration and privately archives exact bytes before projecting fixed fields without inventing event results', () => {
  const { home, root, file } = fixture();
  const raw = `${JSON.stringify({ ...entry, note: 'RAW_NOTE_SECRET', logPath: '/unsafe/RAW_PATH_SECRET', unexpected: 'EXTRA_SECRET' })}\r\n${JSON.stringify({ ...entry, at: '2026-11-16T00:00:00Z', exitCode: null, script: 'echo SECOND_EVENT\rFOLLOWING_SECRET', note: 'session_dead', source: 'session', logPath: '/tmp/mica-ssh-123.log' })}`;
  writeFileSync(file, raw, { mode: 0o644 });
  expect(readAudit(root)).toEqual([]);
  expect(DATA_MIGRATIONS).toContain(sshAuditV2);
  expect(sshAuditV2.run({ home, log() {} })).toBe(2);
  const active = readFileSync(file, 'utf8');
  expect(active).not.toMatch(
    /FIRST_SECRET|SECOND_SECRET|RAW_NOTE_SECRET|RAW_PATH_SECRET|EXTRA_SECRET|FOLLOWING_SECRET/,
  );
  expect(
    active
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  ).toEqual([
    { schemaVersion: 2, ...entry, script: digest('echo FIRST_SECRET'), note: 'diagnostic_omitted' },
    {
      schemaVersion: 2,
      ...entry,
      at: '2026-11-16T00:00:00Z',
      exitCode: null,
      script: digest('echo SECOND_EVENT'),
      source: 'session',
      note: 'session_dead',
      logPath: '/tmp/mica-ssh-123.log',
    },
  ]);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readAudit(root)).toHaveLength(2);
  const archive = join(home, 'plugin-data', 'evolution', 'legacy-ssh-audit');
  const names = readdirSync(archive);
  expect(names).toHaveLength(1);
  expect(readFileSync(join(archive, names[0]!), 'utf8')).toBe(raw);
  expect(statSync(join(archive, names[0]!)).mode & 0o777).toBe(0o600);
  expect(sshAuditV2.run({ home, log() {} })).toBe(0);
  expect(readdirSync(archive)).toEqual(names);
});

it('is safe after interrupted archive creation and retains valid current hashes and fixed notes', () => {
  const { home, root, file } = fixture();
  appendAudit(root, { ...entry, script: 'already current', note: 'command_superseded_completion_unknown' });
  const current = readFileSync(file, 'utf8');
  const raw = `${current}${JSON.stringify(entry)}\n`;
  writeFileSync(file, raw);
  const archive = join(home, 'plugin-data', 'evolution', 'legacy-ssh-audit');
  mkdirSync(archive, { recursive: true });
  const archived = join(archive, `${AUDIT_FILE}.${createHash('sha256').update(raw).digest('hex')}`);
  writeFileSync(archived, raw);
  chmodSync(archived, 0o644);
  expect(sshAuditV2.run({ home, log() {} })).toBe(1);
  expect(statSync(archived).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, 'utf8').startsWith(current)).toBe(true);
  expect(sshAuditV2.run({ home, log() {} })).toBe(0);
  expect(readdirSync(archive)).toHaveLength(1);
});

it('does not race the synchronous audit writer and rereads the current stream after busy deferral', () => {
  const { home, root, file } = fixture();
  const original = JSON.stringify(entry);
  writeFileSync(file, original);
  const release = acquireProcessLock(join(root, AUDIT_LOCK))!;
  try {
    expect(sshAuditV2.run({ home, log() {} })).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(original);
    writeFileSync(file, JSON.stringify({ ...entry, at: '2026-11-18T00:00:00Z', exitCode: 0, ok: true }));
  } finally {
    release();
  }
  expect(sshAuditV2.run({ home, log() {} })).toBe(1);
  expect(readAudit(root)[0]).toMatchObject({ at: '2026-11-18T00:00:00Z', exitCode: 0, ok: true });
});

it.each([
  '{broken',
  JSON.stringify({ ...entry, at: undefined }),
  JSON.stringify({ ...entry, exitCode: '17' }),
  JSON.stringify({ ...entry, schemaVersion: 3 }),
])('does not fabricate missing data or partially migrate an unsupported stream: %s', (bad) => {
  const { home, file } = fixture();
  const original = `${JSON.stringify(entry)}\n${bad}\n`;
  writeFileSync(file, original);
  expect(sshAuditV2.run({ home, log() {} })).toBe(0);
  expect(readFileSync(file, 'utf8')).toBe(original);
  expect(existsSync(join(home, 'plugin-data', 'evolution'))).toBe(false);
});

it('does not replace a conflicting archive or follow an audit symlink', () => {
  const { home, root, file } = fixture();
  const original = JSON.stringify(entry);
  writeFileSync(file, original);
  const archive = join(home, 'plugin-data', 'evolution', 'legacy-ssh-audit');
  mkdirSync(archive, { recursive: true });
  const archived = join(archive, `${AUDIT_FILE}.${createHash('sha256').update(original).digest('hex')}`);
  writeFileSync(archived, 'conflicting original');
  expect(sshAuditV2.run({ home, log() {} })).toBe(0);
  expect(readFileSync(file, 'utf8')).toBe(original);
  expect(readFileSync(archived, 'utf8')).toBe('conflicting original');
  rmSync(file);
  const target = join(root, 'private-target');
  writeFileSync(target, original);
  symlinkSync(target, file);
  expect(sshAuditV2.run({ home, log() {} })).toBe(0);
  expect(readFileSync(target, 'utf8')).toBe(original);
});
