import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginToolDescriptor } from '@packages/mica-tools/PluginTool.js';
import { createTools, type ToolDeps } from './Tools.js';
import { appendAudit, auditFailureCount } from './Audit.js';
import { runRemote, runRemoteMany } from './Remote.js';
import { readData } from './Hosts.js';
import * as fs from 'node:fs';

vi.mock('./Remote.js', () => ({ runRemote: vi.fn(), runRemoteMany: vi.fn(), readHostFingerprint: vi.fn() }));
vi.mock('./Hosts.js', () => ({
  readData: vi.fn(),
  findHost: (data: any, id: string) => data.hosts.find((h: any) => h.id === id),
  mutateData: vi.fn(),
  upsertHost: vi.fn(),
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof fs>()),
  appendFileSync: vi.fn(),
  openSync: vi.fn(() => 42),
  closeSync: vi.fn(),
  fchmodSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
}));
const host = { id: 'test', host: 'example.invalid', user: 'test', port: 22, auth: 'key', readOnly: false };
const good = {
  exitCode: 0,
  output: 'hello',
  totalLines: 1,
  truncated: false,
  logPath: null,
  durationMs: 1,
  timedOut: false,
  aborted: false,
};
function tools() {
  vi.mocked(readData).mockReturnValue({ hosts: [host] } as any);
  const registered: Record<string, PluginToolDescriptor> = {};
  const sessions = {
    get: vi.fn(() => ({ host })),
    list: vi.fn(() => [{ id: 'test', hostId: 'test', target: 'test@example.invalid:22' }]),
    open: vi.fn(() => Promise.resolve({ info: { id: 'test', cwd: '~' }, banner: '' })),
    close: vi.fn(),
    run: vi.fn<(...args: any[]) => any>(),
    write: vi.fn<(...args: any[]) => any>(),
    wait: vi.fn<(...args: any[]) => any>(),
  };
  const scope = { explicit: vi.fn(() => ['test']), set: vi.fn() };
  createTools({
    ctx: { dataDir: '/mock', defaultTimeoutMs: 1000, tailLines: 50 },
    dataFile: '/mock/data.json',
    sessions,
    scope,
    register: (tool: PluginToolDescriptor) => {
      registered[tool.name] = tool;
      return { dispose() {} };
    },
  } as unknown as ToolDeps);
  const execute = async (name: string, input: Record<string, unknown>) =>
    JSON.parse((await registered[name]!.execute!(input)) as string);
  return { execute, sessions, scope };
}
afterEach(() => vi.clearAllMocks());

describe('SSH structured results (no network)', () => {
  it('reports success, nonzero exits, timeout and cancellation without losing human text', async () => {
    const { execute } = tools();
    for (const [change, outcome, code] of [
      [{}, 'success', 'completed'],
      [{ exitCode: 7 }, 'error', 'remote_failed'],
      [{ timedOut: true }, 'error', 'timeout'],
      [{ aborted: true }, 'cancelled', 'aborted'],
    ] as const) {
      vi.mocked(runRemote).mockResolvedValue({ ...good, ...change });
      expect(await execute('ssh_run', { host: 'test', script: 'echo hello' })).toMatchObject({
        outcome,
        code,
        text: expect.stringContaining('hello'),
      });
    }
  });
  it('keeps validation and declined outcomes separate', async () => {
    const { execute } = tools();
    expect(await execute('ssh_run', { host: 'test', script: '' })).toMatchObject({
      outcome: 'error',
      code: 'empty_script',
    });
    expect(await execute('ssh_read', { host: 'test', script: 'rm -rf /x' })).toMatchObject({ outcome: 'declined' });
    expect(await execute('ssh_run', { host: 'missing', script: 'x' })).toMatchObject({ outcome: 'declined' });
    expect(runRemote).not.toHaveBeenCalled();
  });
  it('reports mixed read results as partial', async () => {
    const { execute } = tools();
    vi.mocked(runRemoteMany).mockResolvedValue(new Map([['test', good]]));
    expect(await execute('ssh_read', { hosts: ['test', 'missing'], script: 'ls' })).toMatchObject({
      outcome: 'partial',
      text: expect.stringContaining('hello'),
    });
  });
  it('distinguishes waiting, busy and conflict from failure', async () => {
    const { execute, sessions } = tools();
    sessions.wait.mockResolvedValue({ output: 'still running', exitCode: null, timedOut: true });
    expect(await execute('ssh_session', { op: 'wait', session_id: 'test' })).toMatchObject({
      outcome: 'waiting',
      timedOut: true,
    });
    for (const code of ['busy', 'conflict']) {
      sessions.wait.mockRejectedValue(Object.assign(new Error('try later'), { code }));
      expect(await execute('ssh_session', { op: 'wait', session_id: 'test' })).toMatchObject({ outcome: code, code });
    }
  });
  it('attaches one terminal audit callback to write, not to repeated waits', async () => {
    const { execute, sessions } = tools();
    sessions.write.mockReturnValue({ token: 'mock' });
    sessions.wait.mockResolvedValue({ output: '', exitCode: 0, timedOut: false });
    expect(await execute('ssh_session', { op: 'write', session_id: 'test', command: 'echo hello' })).toMatchObject({
      outcome: 'waiting',
    });
    const complete = sessions.write.mock.calls[0]![2] as (result: object) => void;
    complete({ exitCode: 0, timedOut: false });
    await execute('ssh_session', { op: 'wait', session_id: 'test' });
    await execute('ssh_session', { op: 'wait', session_id: 'test' });
    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fs.appendFileSync).mock.calls[0]![1])).toContain('sha256:');
    expect(String(vi.mocked(fs.appendFileSync).mock.calls[0]![1])).not.toContain('echo hello');
  });
  it('counts audit failures and emits only a fixed diagnostic without breaking remote results', async () => {
    const { execute } = tools();
    vi.mocked(runRemote).mockResolvedValue(good);
    vi.mocked(fs.appendFileSync).mockImplementationOnce(() => {
      throw new Error('sensitive');
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = auditFailureCount();
    expect(await execute('ssh_run', { host: 'test', script: 'echo hello' })).toMatchObject({ outcome: 'success' });
    expect(auditFailureCount()).toBe(before + 1);
    expect(warning).toHaveBeenCalledWith('ssh.audit_write_failed');
    warning.mockRestore();
  });
  it('counts maintenance failures too', () => {
    vi.mocked(fs.readFileSync).mockReturnValueOnce('line\n'.repeat(201));
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw new Error('private');
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = auditFailureCount();
    appendAudit('/mock', {
      at: '',
      hostId: '',
      target: '',
      source: 'run',
      script: '',
      exitCode: 0,
      durationMs: 0,
      ok: true,
    });
    expect(auditFailureCount()).toBe(before + 1);
    expect(warning).toHaveBeenCalledWith('ssh.audit_write_failed');
    warning.mockRestore();
  });

  it('denies read-only open/run/write before the session implementation is called', async () => {
    const { execute, sessions } = tools();
    vi.mocked(readData).mockReturnValue({ hosts: [{ ...host, readOnly: true }] } as any);
    for (const op of ['open', 'run', 'write']) {
      expect(await execute('ssh_session', { op, host: 'test', command: 'echo must-not-run' })).toMatchObject({
        outcome: 'declined',
        code: 'read_only',
      });
    }
    expect(sessions.open).not.toHaveBeenCalled();
    expect(sessions.run).not.toHaveBeenCalled();
    expect(sessions.write).not.toHaveBeenCalled();
    expect(sessions.close).toHaveBeenCalledWith('test');
  });

  it('rechecks revoked scope and removed hosts for old shells; close remains allowed', async () => {
    const { execute, sessions, scope } = tools();
    expect(await execute('ssh_session', { op: 'open', host: 'test' })).toMatchObject({ outcome: 'success' });
    scope.explicit.mockReturnValue([]);
    for (const op of ['run', 'write', 'read', 'wait']) {
      expect(await execute('ssh_session', { op, session_id: 'test', command: 'echo must-not-run' })).toMatchObject({
        outcome: 'declined',
        code: 'host_unavailable',
      });
    }
    scope.explicit.mockReturnValue(['test']);
    vi.mocked(readData).mockReturnValue({ hosts: [] } as any);
    expect(await execute('ssh_session', { op: 'run', session_id: 'test', command: 'echo must-not-run' })).toMatchObject(
      {
        outcome: 'declined',
        code: 'host_unavailable',
      },
    );
    vi.mocked(readData).mockImplementation(() => {
      throw new Error('configuration unavailable');
    });
    expect(await execute('ssh_session', { op: 'close', session_id: 'test' })).toMatchObject({ outcome: 'success' });
    expect(sessions.run).not.toHaveBeenCalled();
    expect(sessions.write).not.toHaveBeenCalled();
    expect(sessions.wait).not.toHaveBeenCalled();
  });
});
