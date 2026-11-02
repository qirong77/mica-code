import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStoredSubagentTasks, writeStoredSubagentTasks } from './subagentState.js';
import type { SubagentTaskRecord } from '../../apps/cli/src/agents/SubagentTaskManager.js';

const previousHome = process.env.MICA_HOME;
const homes: string[] = [];
afterEach(() => {
  if (previousHome === undefined) delete process.env.MICA_HOME;
  else process.env.MICA_HOME = previousHome;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function home(): string {
  const value = mkdtempSync(join(process.cwd(), '.subagent-state-test-'));
  homes.push(value);
  process.env.MICA_HOME = value;
  return value;
}
function task(id: string): SubagentTaskRecord {
  return { id, description: id, subagent_type: 'test', model: 'm', effort: 'low', status: 'running', started_at: '2025-01-01T00:00:00Z', provider_id: 'p', protocol: 'test', timeline: [{ id: 'text', kind: 'text', text: 'progress', at: '2025-01-01T00:00:00Z' }] };
}
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
    } finally { log.mockRestore(); }
  });
  it('keeps independent task updates and restores restart metadata and timeline', () => {
    home();
    writeStoredSubagentTasks('session', [task('one')]);
    writeStoredSubagentTasks('session', [task('two')]);
    writeStoredSubagentTasks('session', [{ ...task('one'), status: 'completed' }]);
    expect(readStoredSubagentTasks('session')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'one', status: 'completed', provider_id: 'p', protocol: 'test', timeline: expect.arrayContaining([expect.objectContaining({ text: 'progress' })]) }),
      expect.objectContaining({ id: 'two', status: 'running' }),
    ]));
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
  it('refuses a restart claim already created by a different process', async () => {
    const dir = home();
    const parent = join(dir, 'subagent-restart-claims');
    mkdirSync(parent);
    const child = spawnSync(process.execPath, ['-e', 'require("fs").mkdirSync(process.argv[1])', join(parent, 'claimed')]);
    expect(child.status).toBe(0);
    const { claimSubagentRestart } = await import('./subagentState.js');
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
