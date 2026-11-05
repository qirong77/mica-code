import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { micaTools } from '@packages/mica-tools/index.js';
import type { CommandRuntimeServices } from '@packages/mica-builtin-commands/index.js';
import {
  extractWrittenPaths,
  installSessionWriteTracking,
  resolveWriterSessionId,
} from '../sessionWriteTracking.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mica-write-tracking-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function services(overrides: Partial<CommandRuntimeServices> = {}): CommandRuntimeServices {
  return {
    getCurrentAgentSessionId: () => 'sess-current',
    listRunningAgents: () => [],
    ...overrides,
  } as unknown as CommandRuntimeServices;
}

describe('extractWrittenPaths', () => {
  it('takes the target of write_file', () => {
    expect(extractWrittenPaths('write_file', { file_path: '/repo/a.ts', content: 'x' })).toEqual(['/repo/a.ts']);
  });

  it('takes every file header of an apply_patch payload, including moves', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: /repo/a.ts',
      '@@',
      '-old',
      '+new',
      '*** Add File: /repo/b.ts',
      '+fresh',
      '*** Delete File: /repo/c.ts',
      '*** Update File: /repo/d.ts',
      '*** Move to: /repo/e.ts',
      '*** End Patch',
    ].join('\n');
    expect(extractWrittenPaths('apply_patch', { patch })).toEqual([
      '/repo/a.ts',
      '/repo/b.ts',
      '/repo/c.ts',
      '/repo/d.ts',
      '/repo/e.ts',
    ]);
  });

  it('reports nothing for tools that do not write files directly', () => {
    expect(extractWrittenPaths('run_shell', { command: 'git show HEAD:x > x' })).toEqual([]);
    expect(extractWrittenPaths('read_file', { file_path: '/repo/a.ts' })).toEqual([]);
    expect(extractWrittenPaths('write_file', {})).toEqual([]);
    expect(extractWrittenPaths('apply_patch', { patch: 42 })).toEqual([]);
  });
});

describe('resolveWriterSessionId', () => {
  it('attributes by agent identity when several sessions share one host process', () => {
    const listRunningAgents = () => [
      { id: 'sess-other', taskOwnerId: 'owner-other' },
      { id: 'sess-mine', taskOwnerId: 'owner-mine' },
    ];
    expect(
      resolveWriterSessionId(services({ listRunningAgents } as Partial<CommandRuntimeServices>), {
        agent: { taskOwnerId: 'owner-mine' },
      }),
    ).toBe('sess-mine');
  });

  it('falls back to the current session when the agent is unknown to this host', () => {
    expect(resolveWriterSessionId(services(), { agent: { taskOwnerId: 'not-listed' } })).toBe('sess-current');
    expect(resolveWriterSessionId(services(), undefined)).toBe('sess-current');
  });
});

describe('installSessionWriteTracking', () => {
  it('records the paths a write tool touched, and only successful ones', async () => {
    const dir = tempDir();
    const recorded: { sessionId: string; paths: string[] }[] = [];
    const tracking = installSessionWriteTracking({ services: services() }, (sessionId, paths) => {
      recorded.push({ sessionId, paths });
    });
    try {
      await micaTools.execute('write_file', { file_path: resolve(dir, 'a.ts'), content: 'x' });
      expect(recorded).toEqual([{ sessionId: 'sess-current', paths: [resolve(dir, 'a.ts')] }]);
      expect(readFileSync(resolve(dir, 'a.ts'), 'utf8')).toBe('x');

      // A rejected call must not end up in the ledger: attribution is about real writes.
      recorded.length = 0;
      await micaTools.execute('write_file', { file_path: resolve(dir, 'b.ts') });
      expect(recorded).toEqual([]);
    } finally {
      tracking.dispose();
    }
  });

  it('stops recording once disposed', async () => {
    const dir = tempDir();
    const recorded: string[] = [];
    const tracking = installSessionWriteTracking({ services: services() }, (_sessionId, paths) => {
      recorded.push(...paths);
    });
    tracking.dispose();
    await micaTools.execute('write_file', { file_path: resolve(dir, 'c.ts'), content: 'x' });
    expect(recorded).toEqual([]);
  });
});
