import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubagentRegistry } from './registry.js';
import { SubagentDriveTool, SubagentInspectTool, SubagentStopTool, SubagentWaitTool } from './tools.js';
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
  it('offers no iteration or token limits on drive', () => {
    const tool = new SubagentDriveTool({} as SubagentRegistry);
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

  it('passes the parent cancellation signal through a new session', async () => {
    const spawn = vi.fn(async () => ({ ok: false, error: 'cancelled' }));
    const controller = new AbortController();
    const tool = new SubagentDriveTool({ spawn } as unknown as SubagentRegistry);
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

  it('returns on the first finished child by default and names the rest', async () => {
    const idle = new SubagentTranscript();
    const running = new SubagentTranscript();
    running.apply({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
    const entries: Record<string, unknown> = {
      a: {
        id: 'a',
        title: '先跑完的',
        cwd: '/tmp',
        createdAt: Date.now(),
        process: { transcript: idle, closed: false, waitForChange: vi.fn(async () => false) },
      },
      b: {
        id: 'b',
        title: '还在跑的',
        cwd: '/tmp',
        createdAt: Date.now(),
        process: { transcript: running, closed: false, waitForChange: vi.fn(async () => false) },
      },
    };
    const tool = new SubagentWaitTool({ get: (id: string) => entries[id] } as unknown as SubagentRegistry);
    const text = await tool.execute({ session_ids: ['a', 'b'] });
    // 并行派三个时不该等齐才回来：第一个结束就要把结果交给模型判断。
    expect(text).toContain('有一个子会话已经满足条件');
    expect(text).toContain('先跑完的');
    expect(text).toContain('还在跑的');
  });

  it('still waits for every child when all: true is explicit', async () => {
    const idle = new SubagentTranscript();
    const running = new SubagentTranscript();
    running.apply({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
    const entries: Record<string, unknown> = {
      a: {
        id: 'a',
        title: '先跑完的',
        cwd: '/tmp',
        createdAt: Date.now(),
        process: { transcript: idle, closed: false, waitForChange: vi.fn(async () => false) },
      },
      b: {
        id: 'b',
        title: '还在跑的',
        cwd: '/tmp',
        createdAt: Date.now(),
        process: { transcript: running, closed: false, waitForChange: vi.fn(async () => false) },
      },
    };
    const registerWatcher = vi.fn();
    const tool = new SubagentWaitTool({
      get: (id: string) => entries[id],
      registerWatcher,
    } as unknown as SubagentRegistry);
    const text = await tool.execute({ session_ids: ['a', 'b'], all: true, timeout_ms: 5 });
    expect(text).toContain('等待超时');
    expect(registerWatcher).toHaveBeenCalledTimes(1);
  });
});

describe('subagent_drive: 新建、接管、追加是同一个动作', () => {
  it('两个都没给时说清少什么，不凭空开一条空会话', async () => {
    const spawn = vi.fn();
    const attach = vi.fn();
    const tool = new SubagentDriveTool({ spawn, attach } as unknown as SubagentRegistry);
    expect(await tool.execute({})).toContain('session_id');
    expect(spawn).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it('只给 prompt 就新建，不碰已有会话', async () => {
    const spawn = vi.fn(async () => ({ ok: false, error: 'stop-here' }));
    const attach = vi.fn();
    const tool = new SubagentDriveTool({ spawn, attach } as unknown as SubagentRegistry);
    expect(await tool.execute({ prompt: '跑一组测试' })).toBe('stop-here');
    expect(attach).not.toHaveBeenCalled();
  });

  it('只给 session_id 就接管，不新建、不投消息', async () => {
    const child = entry();
    const spawn = vi.fn();
    const attach = vi.fn(async () => ({ ok: true as const, entry: child }));
    const tool = new SubagentDriveTool({ spawn, attach, get: () => undefined } as unknown as SubagentRegistry);
    const result = await tool.execute({ session_id: 'child' });
    expect(result).toContain('已接管');
    expect(attach).toHaveBeenCalledWith({ sessionId: 'child' });
    expect(spawn).not.toHaveBeenCalled();
    expect(child.process.send).not.toHaveBeenCalled();
  });

  it('给 session_id + prompt 就是追加一句（顺带接管）', async () => {
    const child = entry();
    const attach = vi.fn(async () => ({ ok: true as const, entry: child }));
    const tool = new SubagentDriveTool({ attach, get: () => undefined } as unknown as SubagentRegistry);
    const result = await tool.execute({ session_id: 'child', prompt: '继续把测试跑完' });
    expect(result).toContain('已发送');
    expect(child.process.send).toHaveBeenCalledWith('继续把测试跑完');
  });

  it('前缀按登记表解析成完整 id 再接管', async () => {
    const child = entry('20261125T095054Z-rrtwhn');
    const attach = vi.fn(async () => ({ ok: true as const, entry: child }));
    const tool = new SubagentDriveTool({ attach, get: () => child } as unknown as SubagentRegistry);
    await tool.execute({ session_id: '20261125T09' });
    expect(attach).toHaveBeenCalledWith({ sessionId: '20261125T095054Z-rrtwhn' });
  });

  it('接管的错误照实回给模型', async () => {
    const tool = new SubagentDriveTool({
      attach: vi.fn(async () => ({ ok: false as const, error: '不能接管当前会话自己；要接着说就直接继续当前对话。' })),
      get: () => undefined,
    } as unknown as SubagentRegistry);
    expect(await tool.execute({ session_id: 'self', prompt: 'x' })).toContain('不能接管当前会话自己');
  });
});

describe('subagent_inspect: 状态与内容是一个「看」轴的六档', () => {
  function registry(entries: unknown[]) {
    return {
      sweep: vi.fn(),
      get: vi.fn((id: string) => entries.find((item) => (item as { id: string }).id.startsWith(id))),
      list: vi.fn(() => entries),
      markRead: vi.fn(),
    } as unknown as SubagentRegistry;
  }

  it('什么都不给时每条一行', async () => {
    const tool = new SubagentInspectTool(registry([entry('a'), entry('b')]));
    const text = await tool.execute({});
    expect(text).toContain('a · 空闲');
    expect(text).toContain('b · 空闲');
  });

  it('full: true 换成收尾视图（原来的 collect）', async () => {
    const tool = new SubagentInspectTool(registry([entry('a')]));
    const text = await tool.execute({ full: true });
    expect(text).not.toContain('（还没有内容）');
    expect(text).toContain('a');
  });

  it('session_ids 只汇总这几条', async () => {
    const tool = new SubagentInspectTool(registry([entry('a'), entry('b')]));
    const text = await tool.execute({ session_ids: ['a'] });
    expect(text).toContain('a');
    expect(text).not.toContain('b · ');
  });

  it('找不到的 id 直接说找不到', async () => {
    const tool = new SubagentInspectTool(registry([]));
    expect(await tool.execute({ session_id: 'nope' })).toContain('找不到子会话');
  });

  it('view 只能取三档，且必须带会话', async () => {
    const tool = new SubagentInspectTool(registry([entry('a')]));
    expect(await tool.execute({ session_id: 'a', view: 'everything' })).toContain('view 必须为');
    expect(await tool.execute({ view: 'turns' })).toContain('需要 session_id 或 session_ids');
  });

  it('view + session_ids 一次读多条（真实链路里模型就是这么传的）', async () => {
    const a = entry('a');
    const b = entry('b');
    const tool = new SubagentInspectTool(registry([a, b]));
    const text = await tool.execute({ view: 'turns', session_ids: ['a', 'b'] });
    expect(text).toContain('会话 a');
    expect(text).toContain('会话 b');
    expect(text).not.toContain('需要 session_id');
  });

  it('多条读正文时按条分摊预算，不会一次灌进三份全文', async () => {
    const entries = ['a', 'b', 'c'].map((id) => {
      const item = entry(id);
      item.process.transcript.apply({ method: 'turn/started', params: { turn: { id: `t-${id}` } } });
      item.process.transcript.apply({
        method: 'item/completed',
        params: { item: { id: `m-${id}`, type: 'agentMessage', text: `${id.repeat(4_000)}` } },
      });
      return item;
    });
    const tool = new SubagentInspectTool(registry(entries));
    const text = await tool.execute({ view: 'transcript', session_ids: ['a', 'b', 'c'], max_chars: 3_000 });
    // 每条至少 1000 字符预算，而不是各自吃满 3000。
    expect(text.length).toBeLessThan(3_200);
    for (const id of ['a', 'b', 'c']) expect(text).toContain(`会话 ${id}`);
  });

  it('full 与 view 同用时再附一份收尾投影（模型会把两个字段一起填）', async () => {
    const tool = new SubagentInspectTool(registry([entry('a'), entry('b')]));
    const text = await tool.execute({ view: 'turns', session_ids: ['a', 'b'], full: true });
    // renderCollect 的开头是「N 个子会话（x 个在跑 / y 个空闲）」，turns 视图没有这行。
    expect(text).toContain('2 个子会话（0 个在跑 / 2 个空闲）');
    expect(text).toContain('会话 a');
    expect(text).toContain('会话 b');
  });

  it('grep 缺 pattern 时不猜', async () => {
    expect(await new SubagentInspectTool(registry([entry('a')])).execute({ session_id: 'a', view: 'grep' })).toContain(
      '需要提供 pattern',
    );
  });

  it('读不到会话时给下一步', async () => {
    expect(await new SubagentInspectTool(registry([])).execute({ session_id: 'x', view: 'turns' })).toContain(
      '找不到子会话',
    );
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

  it('close 给了 id 就只动那一条：idle 是过滤条件，不是「所有空闲的」', async () => {
    const a = entry('a');
    const b = entry('b');
    const closeMany = vi.fn(async (scope: unknown) => (Array.isArray(scope) ? scope : []));
    const get = (id: string) => (id === 'a' ? a : id === 'b' ? b : null);
    const tool = new SubagentStopTool({ get, closeMany } as unknown as SubagentRegistry);
    const output = await tool.execute({ action: 'close', session_id: 'a', idle: true });
    // 真实链路里模型就是这么调的（id 与 idle 一起给）：不能把 b 一起收掉。
    expect(closeMany).toHaveBeenCalledWith(['a']);
    expect(output).toContain('已关闭：a');
    expect(output).not.toContain('已关闭：b');
  });

  it('close 的 idle 把还在跑的那条留在原地，并说清为什么', async () => {
    const running = entry('busy');
    running.process.transcript.apply({ method: 'turn/started', params: { turn: { id: 't1' } } });
    const closeMany = vi.fn(async () => []);
    const tool = new SubagentStopTool({ get: () => running, closeMany } as unknown as SubagentRegistry);
    const output = await tool.execute({ action: 'close', session_id: 'busy', idle: true });
    expect(closeMany).not.toHaveBeenCalled();
    expect(output).toContain('还在跑，没动：busy');
  });

  it('all + idle 是交集：只收跑完的，不收还在跑的', async () => {
    const idle = entry('idle');
    const running = entry('running');
    running.process.transcript.apply({ method: 'turn/started', params: { turn: { id: 't1' } } });
    const closeMany = vi.fn(async (scope: unknown) => (Array.isArray(scope) ? scope : []));
    const tool = new SubagentStopTool({
      list: () => [idle, running],
      closeMany,
    } as unknown as SubagentRegistry);
    const output = await tool.execute({ action: 'close', all: true, idle: true });
    expect(closeMany).toHaveBeenCalledWith(['idle']);
    expect(output).toContain('已关闭：idle');
    expect(output).toContain('还在跑，没动：running');
  });

  it('只给 idle 时在全部里挑跑完的', async () => {
    const idle = entry('idle');
    const closeMany = vi.fn(async (scope: unknown) => (scope === 'idle' ? ['idle'] : Array.isArray(scope) ? scope : []));
    const tool = new SubagentStopTool({ list: () => [idle], closeMany } as unknown as SubagentRegistry);
    expect(await tool.execute({ action: 'close', idle: true })).toContain('已关闭：idle');
    expect(closeMany).toHaveBeenCalledWith('idle');
  });

  it('interrupt 只在真正停下之后才说「已打断」', async () => {
    vi.useFakeTimers();
    const running = entry('child');
    running.process.transcript.apply({ method: 'turn/started', params: { turn: { id: 't1' } } });
    const waitForChange = vi.fn(
      () => new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    );
    const tool = new SubagentStopTool({
      get: () => ({ ...running, process: { ...running.process, abort: async () => true, waitForChange } }),
    } as unknown as SubagentRegistry);
    const pending = tool.execute({ action: 'interrupt', session_id: 'child' });
    await vi.advanceTimersByTimeAsync(4_500);
    expect(await pending).toContain('还在收尾');
  });

  it('interrupt 不接受 idle：那不是打断的力度', async () => {
    const tool = new SubagentStopTool({} as SubagentRegistry);
    expect(await tool.execute({ action: 'interrupt', idle: true })).toContain('idle 只用于 close');
  });
});
