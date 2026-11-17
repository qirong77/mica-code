import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionManager } from './Session.js';
import type { RemoteContext } from './Remote.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    throw new Error('real spawn forbidden');
  }),
}));
afterEach(() => vi.useRealTimers());
it('audits terminal completion once after a write times out and repeated waits do not repeat it', async () => {
  vi.useFakeTimers();
  const manager = new SessionManager({} as RemoteContext);
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), kill: vi.fn() });
  // Seed an in-memory session: no SSH process or credentials are involved.
  const session: any = {
    id: 'mock',
    host: { id: 'mock' },
    child,
    buffer: '',
    waiter: null,
    timer: null,
    counter: 0,
    closed: false,
    last: null,
  };
  (manager as any).sessions.set('mock', session);
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
  const manager = new SessionManager({} as RemoteContext);
  const session: any = { id: 'mock', host: { id: 'mock' }, child: Object.assign(new EventEmitter(), { stdin: new PassThrough(), kill: vi.fn() }), buffer: '', waiter: null, timer: null, counter: 0, closed: false, last: null };
  (manager as any).sessions.set('mock', session);
  const { token } = manager.write('mock', 'echo hello', () => { throw new Error('audit failed'); });
  session.buffer = `done\n\u001e${token} 0\u001e\n`;
  expect(() => (manager as any).flush(session)).not.toThrow();
  expect(await manager.wait('mock', 1000)).toMatchObject({ exitCode: 0 });
  manager.closeAll();
});
