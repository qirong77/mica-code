import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { transformWithOxc } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimSubagentRestart,
  commitSubagentRestart,
  readStoredSubagentTasks,
  releaseSubagentRestart,
  writeStoredSubagentTasks,
  type StoredSubagentTask,
  type SubagentRestartClaim,
} from './subagentState.js';

const previousHome = process.env.MICA_HOME;
const homes: string[] = [];
afterEach(() => {
  if (previousHome === undefined) delete process.env.MICA_HOME;
  else process.env.MICA_HOME = previousHome;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'subagent-state-test-'));
  homes.push(value);
  process.env.MICA_HOME = value;
  return value;
}
function task(id: string): StoredSubagentTask {
  return {
    id,
    description: id,
    subagent_type: 'test',
    model: 'm',
    effort: 'low',
    status: 'running',
    started_at: '2025-01-01T00:00:00Z',
    provider_id: 'p',
    protocol: 'test',
    timeline: [{ id: 'text', kind: 'text', text: 'progress', at: '2025-01-01T00:00:00Z' }],
  };
}
function replacement(claim: SubagentRestartClaim, id = `${claim.id}-replacement`): StoredSubagentTask {
  return {
    ...task(id),
    execution_pid: process.pid,
    execution_pending: true,
    restart_origin: { task_id: claim.id, token: claim.owner.token },
  };
}
const childReplacement = `(claim, id) => ({
  id, description: id, subagent_type: 'test', model: 'm', effort: 'low', status: 'running',
  started_at: '2025-01-01T00:00:00Z', execution_pid: process.pid, execution_pending: true,
  restart_origin: { task_id: claim.id, token: claim.owner.token }
})`;
describe('subagent state', () => {
  it('reports malformed records and write failures', () => {
    const dir = home();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mkdirSync(join(dir, 'subagent-tasks', 'session'), { recursive: true });
      writeFileSync(join(dir, 'subagent-tasks', 'session', 'broken.json'), '{');
      expect(readStoredSubagentTasks('session')).toEqual([]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('reading task broken.json'), expect.anything());
      writeFileSync(join(dir, 'subagent-tasks', 'blocked'), 'not a directory');
      writeStoredSubagentTasks('blocked', [task('one')]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('writing task one'), expect.anything());
    } finally {
      log.mockRestore();
    }
  });
  it('keeps independent task updates and restores restart metadata and timeline', () => {
    home();
    writeStoredSubagentTasks('session', [task('one')]);
    writeStoredSubagentTasks('session', [task('two')]);
    writeStoredSubagentTasks('session', [{ ...task('one'), status: 'completed' }]);
    expect(readStoredSubagentTasks('session')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'one',
          status: 'completed',
          provider_id: 'p',
          protocol: 'test',
          timeline: expect.arrayContaining([expect.objectContaining({ text: 'progress' })]),
        }),
        expect.objectContaining({ id: 'two', status: 'running' }),
      ]),
    );
    expect(readStoredSubagentTasks('another')).toEqual([]);
  });
  it('preserves live and unknown executions and only fails a confirmed dead process', () => {
    home();
    writeStoredSubagentTasks('session', [
      { ...task('live'), execution_pid: process.pid, execution_pending: true },
      { ...task('unknown') },
      { ...task('dead'), execution_pid: 2147483647, execution_pending: true },
    ]);
    const records = readStoredSubagentTasks('session');
    expect(records.find((record) => record.id === 'live')?.status).toBe('running');
    expect(records.find((record) => record.id === 'unknown')?.status).toBe('running');
    expect(records.find((record) => record.id === 'dead')?.status).toBe('failed');
  });
  it('refuses a restart claim already created by a different process', () => {
    const dir = home();
    const parent = join(dir, 'subagent-restart-claims');
    mkdirSync(parent);
    const child = spawnSync(process.execPath, [
      '-e',
      'require("fs").mkdirSync(process.argv[1])',
      join(parent, 'claimed'),
    ]);
    expect(child.status).toBe(0);
    expect(() => claimSubagentRestart('claimed')).toThrow('claimed');
  });
  it('reads legacy records and prefers their per-task updates', () => {
    const dir = home();
    mkdirSync(join(dir, 'subagent-tasks'));
    writeFileSync(join(dir, 'subagent-tasks', 'session.json'), JSON.stringify([task('one'), task('two')]));
    writeStoredSubagentTasks('session', [{ ...task('one'), status: 'completed' }]);
    const restored = readStoredSubagentTasks('session');
    expect(restored).toHaveLength(2);
    expect(restored.find((record) => record.id === 'one')?.status).toBe('completed');
  });
});

// Run the actual claim implementation in Node children without depending on a
// separate TypeScript runtime. Only its two local imports need to be bundled.
let childModuleUrl: string | undefined;
async function childModule(): Promise<string> {
  if (childModuleUrl) return childModuleUrl;
  const transpile = async (url: URL) => (await transformWithOxc(readFileSync(url, 'utf8'), url.pathname)).code;
  const dataUrl = (source: string) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const brand = dataUrl(await transpile(new URL('../mica-config/brand.ts', import.meta.url)));
  const atomicWrite = dataUrl(await transpile(new URL('../mica-config/atomicWrite.ts', import.meta.url)));
  const source = (await transpile(new URL('./subagentState.ts', import.meta.url)))
    .replace('@packages/mica-config/brand.js', brand)
    .replace('@packages/mica-config/atomicWrite.js', atomicWrite);
  childModuleUrl = dataUrl(source);
  return childModuleUrl;
}

async function crashAfterClaim(id: string): Promise<void> {
  const script = `import { claimSubagentRestart } from ${JSON.stringify(await childModule())};
    claimSubagentRestart(${JSON.stringify(id)}); process.kill(process.pid, 'SIGKILL');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: process.env,
    encoding: 'utf8',
  });
  expect({ signal: child.signal, stderr: child.stderr }).toEqual({ signal: 'SIGKILL', stderr: '' });
}

describe('restart claim leases', () => {
  it('recovers after a process crashes with an uncommitted claim', async () => {
    home();
    await crashAfterClaim('crashed');
    const claim = claimSubagentRestart('crashed');
    commitSubagentRestart(claim, replacement(claim));
    expect(() => claimSubagentRestart('crashed')).toThrow('claimed');
  });

  it('recovers an abandoned later generation and fences released owners', async () => {
    home();
    const first = claimSubagentRestart('generations');
    expect(() => claimSubagentRestart('generations')).toThrow('claimed');
    releaseSubagentRestart(first);
    await crashAfterClaim('generations');
    const last = claimSubagentRestart('generations');
    expect(() => commitSubagentRestart(first, replacement(first))).toThrow('claimed');
    commitSubagentRestart(last, replacement(last));
    expect(() => releaseSubagentRestart(first)).toThrow();
    expect(() => claimSubagentRestart('generations')).toThrow('claimed');
  });

  it('keeps a successful restart claimed after its owner exits', async () => {
    home();
    const script = `import { claimSubagentRestart, commitSubagentRestart } from ${JSON.stringify(await childModule())};
      const claim = claimSubagentRestart('started');
      commitSubagentRestart(claim, (${childReplacement})(claim, 'replacement'));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: process.env,
      encoding: 'utf8',
    });
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
    expect(() => claimSubagentRestart('started')).toThrow('claimed');
  });

  it('does not recover if the owner commits just before its liveness check', () => {
    home();
    const claim = claimSubagentRestart('commit-race');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      commitSubagentRestart(claim, replacement(claim));
      throw Object.assign(new Error('process exited'), { code: 'ESRCH' });
    });
    try {
      expect(() => claimSubagentRestart('commit-race')).toThrow('claimed');
    } finally {
      kill.mockRestore();
    }
    expect(() => claimSubagentRestart('commit-race')).toThrow('claimed');
  });

  it('fails closed on legacy and malformed claims but ignores unpublished candidates', () => {
    const dir = home();
    const parent = join(dir, 'subagent-restart-claims');
    mkdirSync(parent);
    mkdirSync(join(parent, 'legacy'));
    writeFileSync(join(parent, 'malformed'), '{');
    writeFileSync(join(parent, 'fresh.orphan.candidate'), '{');
    expect(() => claimSubagentRestart('legacy')).toThrow('claimed');
    expect(() => claimSubagentRestart('malformed')).toThrow('claimed');
    expect(() => claimSubagentRestart('fresh')).not.toThrow();
  });

  it('does not reclaim version 1 claims, including dead and released owners', () => {
    const dir = home();
    const parent = join(dir, 'subagent-restart-claims');
    mkdirSync(parent);
    const token = '11111111-1111-4111-8111-111111111111';
    for (const id of ['old-dead', 'old-released', 'old-started']) {
      writeFileSync(join(parent, id), JSON.stringify({ version: 1, pid: 2147483647, token }));
    }
    writeFileSync(join(parent, `old-released.${token}.released`), '');
    writeFileSync(join(parent, `old-started.${token}.started`), '');
    for (const id of ['old-dead', 'old-released', 'old-started']) {
      expect(() => claimSubagentRestart(id)).toThrow('claimed');
    }
  });

  it('hides a provisional snapshot and releases the claim when the handoff write fails', () => {
    const dir = home();
    const original = { ...task('write-failure'), status: 'failed' as const, execution_pending: false };
    writeStoredSubagentTasks('session', [original]);
    const claim = claimSubagentRestart(original.id);
    const abandoned = replacement(claim, 'abandoned');
    writeStoredSubagentTasks('session', [abandoned]);
    mkdirSync(join(dir, 'subagent-restart-claims', `${claim.id}.${claim.owner.token}.handoff-candidate`));
    expect(() => commitSubagentRestart(claim, abandoned)).toThrow();
    releaseSubagentRestart(claim);
    expect(readStoredSubagentTasks('session').map((record) => record.id)).toEqual([original.id]);

    const retry = claimSubagentRestart(original.id);
    commitSubagentRestart(retry, replacement(retry, 'retry'));
    expect(
      readStoredSubagentTasks('session')
        .map((record) => record.id)
        .sort(),
    ).toEqual(['retry', original.id].sort());
  });

  it('rejects handoffs that are not the claimed deferred execution', () => {
    home();
    const claim = claimSubagentRestart('invalid-handoff');
    const prepared = replacement(claim);
    expect(() => commitSubagentRestart(claim, { ...prepared, restart_origin: undefined })).toThrow('claimed');
    expect(() => commitSubagentRestart(claim, { ...prepared, execution_pending: false })).toThrow('claimed');
    expect(() => commitSubagentRestart(claim, { ...prepared, execution_pid: 2147483647 })).toThrow('claimed');
    releaseSubagentRestart(claim);
  });

  it('recovers a pre-commit crash without exposing its provisional task', async () => {
    home();
    writeStoredSubagentTasks('session', [{ ...task('before-commit'), status: 'failed', execution_pending: false }]);
    const script = `import { claimSubagentRestart, writeStoredSubagentTasks } from ${JSON.stringify(await childModule())};
      const claim = claimSubagentRestart('before-commit');
      writeStoredSubagentTasks('session', [(${childReplacement})(claim, 'orphan')]);
      process.kill(process.pid, 'SIGKILL');`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: process.env,
      encoding: 'utf8',
    });
    expect({ signal: child.signal, stderr: child.stderr }).toEqual({ signal: 'SIGKILL', stderr: '' });
    expect(readStoredSubagentTasks('session').map((record) => record.id)).toEqual(['before-commit']);
    const retry = claimSubagentRestart('before-commit');
    commitSubagentRestart(retry, replacement(retry, 'safe-retry'));
    expect(
      readStoredSubagentTasks('session')
        .map((record) => record.id)
        .sort(),
    ).toEqual(['before-commit', 'safe-retry']);
  });

  it('recovers a committed replacement after SIGKILL even without its snapshot', async () => {
    home();
    writeStoredSubagentTasks('session', [{ ...task('after-commit'), status: 'failed', execution_pending: false }]);
    const script = `import { claimSubagentRestart, commitSubagentRestart } from ${JSON.stringify(await childModule())};
      const claim = claimSubagentRestart('after-commit');
      commitSubagentRestart(claim, (${childReplacement})(claim, 'durable-replacement'));
      process.kill(process.pid, 'SIGKILL');`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: process.env,
      encoding: 'utf8',
    });
    expect({ signal: child.signal, stderr: child.stderr }).toEqual({ signal: 'SIGKILL', stderr: '' });
    const records = readStoredSubagentTasks('session');
    expect(records.find((record) => record.id === 'durable-replacement')).toMatchObject({
      status: 'failed',
      error: 'Application restarted before this task completed.',
      restart_origin: { task_id: 'after-commit' },
    });
    expect(readStoredSubagentTasks('other-session')).toEqual([]);
    expect(() => claimSubagentRestart('after-commit')).toThrow('claimed');
    const continuation = claimSubagentRestart('durable-replacement');
    commitSubagentRestart(continuation, replacement(continuation, 'continued'));
    expect(
      readStoredSubagentTasks('session')
        .map((record) => record.id)
        .sort(),
    ).toEqual(['after-commit', 'continued', 'durable-replacement']);
  });

  it('lets exactly one process recover the same abandoned claim', async () => {
    home();
    await crashAfterClaim('race');
    const script = `import { claimSubagentRestart } from ${JSON.stringify(await childModule())};
      console.log('ready');
      process.stdin.once('data', () => {
        try { claimSubagentRestart('race'); console.log('claimed'); }
        catch { console.log('rejected'); }
      });
      process.stdin.resume(); setInterval(() => {}, 1000);`;
    const children = Array.from({ length: 6 }, () =>
      spawn(process.execPath, ['--input-type=module', '-e', script], {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    const exits = children.map((child) => new Promise<void>((resolve) => child.once('exit', () => resolve())));
    const readers = children.map((child) => createInterface({ input: child.stdout }));
    const lines = readers.map((reader) => reader[Symbol.asyncIterator]());
    try {
      const ready = await Promise.all(lines.map((line) => line.next()));
      expect(ready.map((item) => item.value)).toEqual(Array(6).fill('ready'));
      for (const child of children) child.stdin.write('go\n');
      const results = (await Promise.all(lines.map((line) => line.next()))).map((item) => item.value);
      expect(results.filter((result) => result === 'claimed')).toHaveLength(1);
      expect(results.filter((result) => result === 'rejected')).toHaveLength(5);
      expect(() => claimSubagentRestart('race')).toThrow('claimed');
    } finally {
      for (const child of children) child.kill('SIGKILL');
      await Promise.all(exits);
      for (const reader of readers) reader.close();
    }
    // The winner also died without committing, so its generation is recoverable.
    const recovered = claimSubagentRestart('race');
    commitSubagentRestart(recovered, replacement(recovered));
    expect(() => claimSubagentRestart('race')).toThrow('claimed');
  });
});
