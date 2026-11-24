import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { buildSidecarIssuePrompt } from './issue.js';
import { SidecarRegistry } from './registry.js';
import { SidecarProcess } from './sidecarProcess.js';

afterEach(() => vi.restoreAllMocks());

function processFor(id: string) {
  return {
    sessionId: id,
    cwd: '/tmp',
    closed: false,
    transcript: { finishedTurnCount: 0 },
    send: vi.fn(async () => ({ queued: false })),
    close: vi.fn(async () => undefined),
  } as unknown as SidecarProcess;
}

describe('sidecar issue prompt', () => {
  it('wraps the first task with readable parent context', () => {
    expect(
      buildSidecarIssuePrompt({ parentId: 'parent-a', parentTitle: '需求开发', task: '  做 X  ' }),
    ).toBe([
      '<context>',
      '父会话：需求开发',
      '父会话 ID：parent-a',
      '</context>',
      '<task>',
      '做 X',
      '</task>',
      '',
      '这是父会话派发给你的一个 issue。请围绕 <task> 执行，完成后汇报结果、改动和实际验证情况。',
    ].join('\n'));
  });

  it('keeps a nested A to B to C parent chain', async () => {
    let current = { id: 'session-a', cwd: '/tmp', title: 'A', role: 'default' };
    const parent = new SidecarRegistry(
      { session: { describe: () => current }, logger: { info() {}, warn() {}, error() {} } } as unknown as PluginContext,
      current.id,
      current.cwd,
      () => current.role,
    );
    const child = processFor('session-b');
    const grandchild = processFor('session-c');
    const start = vi.spyOn(SidecarProcess, 'start')
      .mockResolvedValueOnce(child)
      .mockResolvedValueOnce(grandchild);

    const b = await parent.spawn({ prompt: '任务 X', title: 'B' });
    expect(b.ok).toBe(true);
    expect(start.mock.calls[0]?.[0]).toMatchObject({ parentSessionId: 'session-a' });
    expect(child.send).toHaveBeenCalledWith(expect.stringContaining('父会话 ID：session-a'));

    current = { id: 'session-b', cwd: '/tmp', title: 'B', role: 'default' };
    const childRegistry = new SidecarRegistry(
      { session: { describe: () => current }, logger: { info() {}, warn() {}, error() {} } } as unknown as PluginContext,
      current.id,
      current.cwd,
      () => current.role,
    );
    const c = await childRegistry.spawn({ prompt: '任务 Y', title: 'C' });
    expect(c.ok).toBe(true);
    expect(start.mock.calls[1]?.[0]).toMatchObject({ parentSessionId: 'session-b' });
    expect(grandchild.send).toHaveBeenCalledWith(expect.stringContaining('父会话 ID：session-b'));
    await parent.closeAll();
    await childRegistry.closeAll();
  });
});
