import { describe, expect, it, vi } from 'vitest';
import type { SubagentEvent } from './events.js';
import {
  renderWakePrompt,
  shouldWake,
  SubagentWaker,
  wakeDisplay,
  type SubagentWakeHost,
} from './wake.js';

function event(overrides: Partial<SubagentEvent> = {}): SubagentEvent {
  return {
    id: 1,
    at: Date.UTC(2026, 10, 25, 12, 0, 0),
    sessionId: 'child-1',
    title: '跑测试',
    kind: 'turn',
    summary: '完成 · 12s',
    ...overrides,
  };
}

function harness(overrides: Partial<SubagentWakeHost> = {}, initial: SubagentEvent[] = [event()]) {
  const events = [...initial];
  const consumed: number[][] = [];
  const submit = vi.fn(async () => true);
  const notice = vi.fn();
  const host: SubagentWakeHost = {
    inTurn: () => false,
    busy: () => false,
    draft: () => '',
    queued: () => 0,
    peek: () => events.map((entry) => ({ ...entry })),
    consume: (ids) => {
      consumed.push([...ids]);
      for (const id of ids) {
        const index = events.findIndex((entry) => entry.id === id);
        if (index >= 0) events.splice(index, 1);
      }
    },
    submit,
    notice,
    ...overrides,
  };
  return { host, events, consumed, submit, notice };
}

describe('shouldWake', () => {
  it('wakes for work that actually changed state', () => {
    for (const kind of ['turn', 'exit', 'stalled', 'watch'] as const) {
      expect(shouldWake(event({ kind }))).toBe(true);
    }
  });

  it('stays quiet for the parent-owned and informational events', () => {
    for (const kind of ['attach', 'recycled', 'info'] as const) {
      expect(shouldWake(event({ kind }))).toBe(false);
    }
  });
});

describe('renderWakePrompt', () => {
  it('marks the input as a system event and carries every line', () => {
    const text = renderWakePrompt([
      event(),
      event({ id: 2, sessionId: 'child-2', title: '查调用点', kind: 'exit', summary: '子会话进程已退出' }),
    ]);
    expect(text).toContain('不是用户发言');
    expect(text).toContain('child-1');
    expect(text).toContain('跑测试');
    expect(text).toContain('child-2');
    expect(text).toContain('查调用点');
    expect(text).toContain('subagent_inspect');
  });

  it('keeps the display line short even with many children', () => {
    const many = Array.from({ length: 5 }, (_, index) =>
      event({ id: index + 1, sessionId: `child-${index}`, title: `子会话 ${index}` }),
    );
    expect(wakeDisplay(many)).toContain('等 5 个');
  });
});

describe('SubagentWaker', () => {
  it('submits one system turn and consumes the events that were sent', async () => {
    const { host, events, consumed, submit, notice } = harness();
    const waker = new SubagentWaker(host);
    await waker.flush();

    expect(submit).toHaveBeenCalledOnce();
    const [text, display] = submit.mock.calls[0] as unknown as [string, string];
    expect(text).toContain('子会话动态');
    expect(display).toBe('子会话动态：跑测试');
    expect(consumed).toEqual([[1]]);
    expect(events).toHaveLength(0);
    expect(notice).toHaveBeenCalledOnce();
  });

  it('does not take the turn while the parent is still running', async () => {
    const { host, submit } = harness({ inTurn: () => true });
    await new SubagentWaker(host).flush();
    expect(submit).not.toHaveBeenCalled();
  });

  it('does not steal the slot from a busy host, a queued message, or a draft', async () => {
    for (const overrides of [
      { busy: () => true },
      { queued: () => 1 },
      { draft: () => '我先说一句' },
    ] satisfies Partial<SubagentWakeHost>[]) {
      const { host, submit } = harness(overrides);
      await new SubagentWaker(host).flush();
      expect(submit).not.toHaveBeenCalled();
    }
  });

  it('leaves informational events for the next prompt instead of waking for them', async () => {
    const { host, submit } = harness({}, [event({ kind: 'info', summary: '角色退化' })]);
    await new SubagentWaker(host).flush();
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps the events when the host refuses the submit', async () => {
    const { host, events, consumed } = harness({ submit: vi.fn(async () => false) });
    await new SubagentWaker(host).flush();
    expect(consumed).toHaveLength(0);
    expect(events).toHaveLength(1);
  });

  it('debounces a burst into a single scheduled flush', async () => {
    let scheduled: (() => void) | null = null;
    const { host } = harness({
      setTimer: (run) => {
        scheduled = run;
        return Symbol('timer');
      },
      clearTimer: () => undefined,
    });
    const waker = new SubagentWaker(host);
    waker.schedule();
    waker.schedule();
    expect(scheduled).not.toBeNull();
    scheduled!();
    await vi.waitFor(() => expect(host.peek()).toHaveLength(0));
    waker.dispose();
  });

  it('flushes at a turn boundary without waiting for the debounce window', async () => {
    const timers: { run: () => void; ms: number }[] = [];
    const { host } = harness({
      setTimer: (run, ms) => {
        timers.push({ run, ms });
        return Symbol('timer');
      },
    });
    const waker = new SubagentWaker(host);
    waker.flushSoon();
    expect(timers.at(-1)?.ms).toBe(0);
    timers.at(-1)!.run();
    await vi.waitFor(() => expect(host.peek()).toHaveLength(0));
    waker.dispose();
  });
});
