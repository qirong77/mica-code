import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionManager } from './Session.js';
import type { RemoteContext } from './Remote.js';
import { readData, type SshHost } from './Hosts.js';

vi.mock('./Hosts.js', () => ({ readData: vi.fn() }));
vi.mock('./Remote.js', () => ({
  buildSshArgs: vi.fn(() => ['mock-target']),
  createAskpass: vi.fn(),
  disposeAskpass: vi.fn(),
  shellQuote: (value: string) => `'${value}'`,
}));
vi.mock('./Secrets.js', () => ({ readPassword: vi.fn(() => null) }));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const host: SshHost = {
  id: 'mock',
  host: 'example.invalid',
  port: 22,
  user: 'mock',
  auth: 'key',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};
let allowed: string[];
const access = { dataFile: '/mock/data.json', scope: { explicit: () => allowed, set: () => {} } };
beforeEach(() => {
  vi.clearAllMocks();
  allowed = ['mock'];
  vi.mocked(readData).mockReturnValue({ version: 1, updatedAt: '', hosts: [{ ...host }] });
  vi.mocked(spawn).mockImplementation(() => {
    throw new Error('real spawn forbidden');
  });
});
afterEach(() => vi.useRealTimers());

function seeded() {
  const manager = new SessionManager({} as RemoteContext, access);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const session = {
    id: 'mock',
    host: { ...host },
    child,
    buffer: '',
    waiter: null,
    timer: null,
    counter: 0,
    closed: false,
    last: null,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    cwd: '~',
    askpass: null,
  };
  (manager as any).sessions.set('mock', session);
  return { manager, child, session };
}

it('audits terminal completion once after a write times out and repeated waits do not repeat it', async () => {
  vi.useFakeTimers();
  const { manager, session } = seeded();
  const completed = vi.fn();
  const { token } = manager.write('mock', 'echo hello', completed);
  const waiting = manager.wait('mock', 1000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await waiting).toMatchObject({ timedOut: true });
  expect(completed).not.toHaveBeenCalled();
  expect(() => manager.write('mock', 'must not replace the command')).toThrow('仍在运行');
  expect(completed).not.toHaveBeenCalled();
  session.buffer = `hello\n\u001e${token} 7\u001e\n`;
  (manager as any).flush(session);
  expect(completed).toHaveBeenCalledExactlyOnceWith({ output: 'hello\n', exitCode: 7, timedOut: false });
  expect(await manager.wait('mock', 1000)).toMatchObject({ exitCode: 7 });
  await manager.wait('mock', 1000);
  expect(completed).toHaveBeenCalledTimes(1);
  manager.closeAll();
});

it('does not strand completion if an audit callback throws', async () => {
  vi.useFakeTimers();
  const { manager, session } = seeded();
  const { token } = manager.write('mock', 'echo hello', () => {
    throw new Error('audit failed');
  });
  session.buffer = `done\n\u001e${token} 0\u001e\n`;
  expect(() => (manager as any).flush(session)).not.toThrow();
  expect(await manager.wait('mock', 1000)).toMatchObject({ exitCode: 0 });
  manager.closeAll();
});

it('rejects read-only open before spawning any shell', async () => {
  const manager = new SessionManager({} as RemoteContext, access);
  vi.mocked(readData).mockReturnValue({ version: 1, updatedAt: '', hosts: [{ ...host, readOnly: true }] });
  await expect(manager.open(host)).rejects.toMatchObject({ code: 'read_only' });
  expect(spawn).not.toHaveBeenCalled();
});

it('opens an authorized shell using only a fake child and rechecks it before initialization', async () => {
  const manager = new SessionManager({} as RemoteContext, access);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as never);
  vi.spyOn(child.stdin, 'write').mockImplementation((input) => {
    const token = /MICA_SSH_\d+_[a-f0-9]+/.exec(String(input))![0];
    queueMicrotask(() => child.stdout.emit('data', `\u001e${token} 0\u001e\n`));
    return true;
  });
  expect(await manager.open(host)).toMatchObject({ info: { id: 'mock', hostId: 'mock' } });
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(readData).toHaveBeenCalled();
  manager.closeAll();
});

it.each(['run', 'write'] as const)('rechecks readOnly immediately before %s writes stdin', async (op) => {
  const { manager, child } = seeded();
  const written = vi.spyOn(child.stdin, 'write');
  vi.mocked(readData).mockReturnValue({ version: 1, updatedAt: '', hosts: [{ ...host, readOnly: true }] });
  const execute = async () =>
    op === 'run' ? manager.run('mock', 'must-not-run', 1000) : manager.write('mock', 'must-not-run');
  await expect(execute()).rejects.toMatchObject({ code: 'read_only' });
  expect(written).not.toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  expect(manager.get('mock')).toBeNull();
});

it.each(['scope', 'removed', 'changed', 'io'] as const)(
  'invalidates an old shell after %s and settles its audit once',
  async (kind) => {
    const { manager, child } = seeded();
    const written = vi.spyOn(child.stdin, 'write');
    const completion = vi.fn();
    manager.write('mock', 'first-command', completion);
    if (kind === 'scope') allowed = [];
    if (kind === 'removed') vi.mocked(readData).mockReturnValue({ version: 1, updatedAt: '', hosts: [] });
    if (kind === 'changed')
      vi.mocked(readData).mockReturnValue({ version: 1, updatedAt: '', hosts: [{ ...host, host: 'other.invalid' }] });
    if (kind === 'io')
      vi.mocked(readData).mockImplementation(() => {
        throw Object.assign(new Error('IO failure'), { code: 'EIO' });
      });
    await expect(manager.run('mock', 'must-not-run', 1000)).rejects.toMatchObject({
      code: kind === 'changed' ? 'session_stale' : kind === 'io' ? 'EIO' : 'host_unavailable',
    });
    expect(written).toHaveBeenCalledTimes(1);
    expect(completion).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ dead: true }));
    manager.close('mock');
    expect(completion).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
  },
);

it.each(['read', 'wait'] as const)(
  'does not expose revoked buffered output through %s; close is unconditional',
  async (op) => {
    const { manager, child, session } = seeded();
    session.buffer = 'private buffered output';
    allowed = [];
    const execute = async () => (op === 'read' ? manager.read('mock') : manager.wait('mock', 1000));
    await expect(execute()).rejects.toMatchObject({ code: 'host_unavailable' });
    expect(child.kill).toHaveBeenCalledTimes(1);
    vi.mocked(readData).mockImplementation(() => {
      throw new Error('unreadable');
    });
    expect(() => manager.close('mock')).not.toThrow();
  },
);

it('omits and closes revoked sessions during list without treating IO failure as an empty list', () => {
  const { manager, child } = seeded();
  allowed = [];
  expect(manager.list()).toEqual([]);
  expect(child.kill).toHaveBeenCalledTimes(1);
  const next = seeded();
  allowed = ['mock'];
  vi.mocked(readData).mockImplementation(() => {
    throw Object.assign(new Error('IO failure'), { code: 'EIO' });
  });
  expect(() => next.manager.list()).toThrow('IO failure');
  expect(next.child.kill).toHaveBeenCalledTimes(1);
});
