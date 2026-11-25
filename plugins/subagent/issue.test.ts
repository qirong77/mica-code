import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { buildSubagentIssuePrompt } from './issue.js';
import { SubagentRegistry } from './registry.js';
import { SubagentProcess } from './subagentProcess.js';

afterEach(() => vi.restoreAllMocks());

function processFor(id: string) {
  return {
    sessionId: id,
    cwd: '/tmp',
    closed: false,
    transcript: { finishedTurnCount: 0 },
    send: vi.fn(async () => ({ queued: false })),
    close: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
  } as unknown as SubagentProcess;
}

describe('subagent issue prompt', () => {
  it('wraps the first task with readable parent context', () => {
    expect(
      buildSubagentIssuePrompt({ parentId: 'parent-a', parentTitle: '需求开发', task: '  做 X  ' }),
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
    const parent = new SubagentRegistry(
      { session: { describe: () => current }, logger: { info() {}, warn() {}, error() {} } } as unknown as PluginContext,
      current.id,
      current.cwd,
      () => current.role,
    );
    const child = processFor('session-b');
    const grandchild = processFor('session-c');
    const start = vi.spyOn(SubagentProcess, 'start')
      .mockResolvedValueOnce(child)
      .mockResolvedValueOnce(grandchild);

    const b = await parent.spawn({ prompt: '任务 X', title: 'B' });
    expect(b.ok).toBe(true);
    expect(start.mock.calls[0]?.[0]).toMatchObject({ parentSessionId: 'session-a' });
    expect(child.send).toHaveBeenCalledWith(expect.stringContaining('父会话 ID：session-a'));
    // 侧栏读的是子会话自己的落盘标题：派活时给的名字要写进它，而不是留给
    // `derive` 把 `<context>` 那一行当标题。
    expect(child.rename).toHaveBeenCalledWith('B');

    current = { id: 'session-b', cwd: '/tmp', title: 'B', role: 'default' };
    const childRegistry = new SubagentRegistry(
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

  it('spawns anyway when the child refuses to be renamed', async () => {
    const current = { id: 'session-a', cwd: '/tmp', title: 'A', role: 'default' };
    const warnings: unknown[] = [];
    const parent = new SubagentRegistry(
      {
        session: { describe: () => current },
        logger: { info() {}, warn: (...args: unknown[]) => warnings.push(args), error() {} },
      } as unknown as PluginContext,
      current.id,
      current.cwd,
      () => current.role,
    );
    const child = processFor('session-b');
    (child.rename as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('unsupported'));
    vi.spyOn(SubagentProcess, 'start').mockResolvedValueOnce(child);

    const b = await parent.spawn({ prompt: '任务 X' });
    expect(b.ok).toBe(true);
    expect(child.send).toHaveBeenCalled();
    expect(warnings.length).toBe(1);
    await parent.closeAll();
  });
});
