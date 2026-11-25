import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubagentRegistry } from './registry.js';
import { SubagentOpenTool, SubagentReadTool, SubagentStatusTool, SubagentStopTool, SubagentWaitTool } from './tools.js';
import { SubagentTranscript } from './transcript.js';

afterEach(() => vi.useRealTimers());

function entry(id = 'child') {
  return {
    id,
    title: '干活的子会话',
    cwd: '/tmp/work',
    process: { transcript: new SubagentTranscript(), closed: false, send: vi.fn(async () => ({ queued: false })) },
  };
}

describe('subagent tool boundaries', () => {
  it('offers no iteration or token limits on open', () => {
    const tool = new SubagentOpenTool({} as SubagentRegistry);
    // 迭代上限与 token 预算都不暴露给模型：派活时只写目标，不要顺手给自己上闸。
    expect(tool.input_schema.properties?.max_turns).toBeUndefined();
    expect(tool.input_schema.properties?.max_tokens).toBeUndefined();
  });

  it.each([{ until: 'typo' }, { timeout_ms: 0 }, { timeout_ms: -1 }, { timeout_ms: NaN }, { timeout_ms: Infinity }])(
    'rejects invalid wait input before subscribing: %j',
    async (input) => {
      const get = vi.fn();
      const tool = new SubagentWaitTool({ get } as unknown as SubagentRegistry);
      expect(await tool.execute({ session_id: 'child', ...input })).toMatch(/必须/);
      expect(get).not.toHaveBeenCalled();
    },
  );

  it('passes the parent cancellation signal through a spawn', async () => {
    const spawn = vi.fn(async () => ({ ok: false, error: 'cancelled' }));
    const controller = new AbortController();
    const tool = new SubagentOpenTool({ spawn } as unknown as SubagentRegistry);
    await tool.execute({ prompt: 'work' }, { signal: controller.signal });
    expect(spawn).toHaveBeenCalledWith({ prompt: 'work', signal: controller.signal });
  });

  it('cancels an outstanding wait without advancing the polling clock', async () => {
    vi.useFakeTimers();
    const transcript = new SubagentTranscript();
    transcript.apply({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
    const waitForChange = vi.fn(
      (_timeout: number, signal?: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          signal?.addEventListener('abort', () => resolve(false), { once: true });
        }),
    );
    const child = { id: 'child', process: { transcript, closed: false, waitForChange } };
    const tool = new SubagentWaitTool({ get: () => child } as unknown as SubagentRegistry);
    const controller = new AbortController();
    const started = Date.now();
    const waiting = tool.execute({ session_id: 'child' }, { signal: controller.signal });
    expect(waitForChange).toHaveBeenCalledWith(500, controller.signal);
    controller.abort();
    expect(await waiting).toContain('已取消等待');
    expect(Date.now()).toBe(started);
  });
});

describe('subagent_open: 新建与接管是同一个动作的两条路', () => {
  it('两个都没给时说清少什么，不凭空开一条空会话', async () => {
    const spawn = vi.fn();
    const attach = vi.fn();
    const tool = new SubagentOpenTool({ spawn, attach } as unknown as SubagentRegistry);
    expect(await tool.execute({})).toContain('session_id');
    expect(spawn).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it('给 session_id 就接管，不会新建', async () => {
    const child = entry();
    const spawn = vi.fn();
    const attach = vi.fn(async () => ({ ok: true as const, entry: child }));
    const tool = new SubagentOpenTool({ spawn, attach } as unknown as SubagentRegistry);
    const result = await tool.execute({ session_id: 'child' });
    expect(result).toContain('已接管');
    expect(attach).toHaveBeenCalledWith({ sessionId: 'child' });
    expect(spawn).not.toHaveBeenCalled();
    expect(child.process.send).not.toHaveBeenCalled();
  });

  it('接管并同时派活时，接完就把那句话投出去', async () => {
    const child = entry();
    const attach = vi.fn(async () => ({ ok: true as const, entry: child }));
    const tool = new SubagentOpenTool({ attach } as unknown as SubagentRegistry);
    const result = await tool.execute({ session_id: 'child', prompt: '继续把测试跑完' });
    expect(result).toContain('已接管');
    expect(result).toContain('已发送');
    expect(child.process.send).toHaveBeenCalledWith('继续把测试跑完');
  });

  it('接管的对话关不回自己', async () => {
    const tool = new SubagentOpenTool({
      attach: vi.fn(async () => ({ ok: false as const, error: '不能接管当前会话自己；要接着说就直接继续当前对话。' })),
    } as unknown as SubagentRegistry);
    expect(await tool.execute({ session_id: 'self', prompt: 'x' })).toContain('不能接管当前会话自己');
  });
});

describe('subagent_status: 进度与收尾是同一个视图的两种详细度', () => {
  function registry(entries: unknown[]) {
    return {
      sweep: vi.fn(),
      get: vi.fn((id: string) => entries.find((item) => (item as { id: string }).id.startsWith(id))),
      list: vi.fn(() => entries),
      markRead: vi.fn(),
    } as unknown as SubagentRegistry;
  }

  it('不带 id 与 full 时每条一行', async () => {
    const tool = new SubagentStatusTool(registry([entry('a'), entry('b')]));
    const text = await tool.execute({});
    expect(text).toContain('a · 空闲');
    expect(text).toContain('b · 空闲');
  });

  it('full: true 换成收尾视图（原来的 collect）', async () => {
    const tool = new SubagentStatusTool(registry([entry('a')]));
    const text = await tool.execute({ full: true });
    expect(text).not.toContain('（还没有内容）');
    expect(text).toContain('a');
  });

  it('session_ids 只汇总这几条', async () => {
    const tool = new SubagentStatusTool(registry([entry('a'), entry('b')]));
    const text = await tool.execute({ session_ids: ['a'] });
    expect(text).toContain('a');
    expect(text).not.toContain('b · ');
  });

  it('找不到的 id 直接说找不到', async () => {
    const tool = new SubagentStatusTool(registry([]));
    expect(await tool.execute({ session_id: 'nope' })).toContain('找不到子会话');
  });
});

describe('subagent_read: 三档成本用一个 view 选', () => {
  const tool = new SubagentReadTool({ sweep: vi.fn(), get: vi.fn(), markRead: vi.fn() } as unknown as SubagentRegistry);

  it('view 只能取三档', async () => {
    expect(await tool.execute({ session_id: 'x', view: 'everything' })).toContain('view 必须为');
  });

  it('grep 缺 pattern 时不猜', async () => {
    const registry = {
      sweep: vi.fn(),
      get: vi.fn(() => entry('x')),
      markRead: vi.fn(),
    } as unknown as SubagentRegistry;
    expect(await new SubagentReadTool(registry).execute({ session_id: 'x', view: 'grep' })).toContain('需要提供 pattern');
  });

  it('读不到会话时给下一步', async () => {
    expect(await tool.execute({ session_id: 'x', view: 'turns' })).toContain('找不到子会话');
  });
});

describe('subagent_stop: 打断与收掉是同一个动作的两种力度', () => {
  it('action 只能取两种力度', async () => {
    const tool = new SubagentStopTool({} as SubagentRegistry);
    expect(await tool.execute({ action: 'kill', session_id: 'x' })).toContain('必须为 interrupt 或 close');
  });

  it('没给目标时不瞎猜', async () => {
    const tool = new SubagentStopTool({} as SubagentRegistry);
    expect(await tool.execute({ action: 'close' })).toContain('看不出要停哪一条');
  });

  it('interrupt 只打断当前这一轮', async () => {
    const child = entry();
    const abort = vi.fn(async () => true);
    const tool = new SubagentStopTool({
      get: () => ({ ...child, process: { ...child.process, abort } }),
    } as unknown as SubagentRegistry);
    expect(await tool.execute({ action: 'interrupt', session_id: 'child' })).toContain('已打断');
    expect(abort).toHaveBeenCalledOnce();
  });

  it('close 收掉进程，all / idle 走批量口径', async () => {
    const closeMany = vi.fn(async () => ['a', 'b']);
    const tool = new SubagentStopTool({ closeMany } as unknown as SubagentRegistry);
    expect(await tool.execute({ action: 'close', all: true })).toContain('已关闭');
    expect(closeMany).toHaveBeenCalledWith('all');
    await tool.execute({ action: 'close', idle: true });
    expect(closeMany).toHaveBeenCalledWith('idle');
  });
});
