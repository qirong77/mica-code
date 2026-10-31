import { describe, expect, it } from 'vitest';
import { SidecarTranscript } from './transcript.js';
import { waitBaseline, waitSatisfied, type SidecarEntry } from './registry.js';
import { renderSidecar } from './views.js';

const delta = (text: string) => ({ method: 'item/agentMessage/delta', params: { delta: text } });
const turnStarted = (id = 't1') => ({ method: 'turn/started', params: { turn: { id } } });
const turnCompleted = (status = 'completed', error?: string) => ({
  method: 'turn/completed',
  params: { turn: { id: 't1', status, ...(error ? { error: { message: error } } : {}) } },
});

function fakeEntry(transcript: SidecarTranscript): SidecarEntry {
  return {
    id: 'child-1',
    title: 'probe',
    cwd: '/tmp',
    createdAt: Date.now(),
    process: { transcript, closed: false, describeFailure: () => '' },
  } as unknown as SidecarEntry;
}

describe('SidecarTranscript', () => {
  it('accumulates text deltas and lets item/completed replace them with the full text', () => {
    const transcript = new SidecarTranscript();
    transcript.apply(turnStarted());
    transcript.apply(delta('正在'));
    transcript.apply(delta('检查'));
    expect(transcript.activeTurn?.text).toBe('正在检查');
    // completed 带全文：delta 丢包或重发都不会让正文错位。
    transcript.apply({
      method: 'item/completed',
      params: { item: { type: 'agentMessage', id: 'm1', text: '正在检查测试结果' } },
    });
    expect(transcript.activeTurn?.text).toBe('正在检查测试结果');
  });

  it('tracks a tool call from inProgress to completed with its output', () => {
    const transcript = new SidecarTranscript();
    transcript.apply(turnStarted());
    transcript.apply({
      method: 'item/started',
      params: {
        item: { type: 'commandExecution', id: 'c1', displayText: 'run_shell bun run test', status: 'inProgress' },
      },
    });
    expect(transcript.activeTurn?.tools[0]).toMatchObject({ id: 'c1', status: 'running' });

    transcript.apply({ method: 'item/commandExecution/outputDelta', params: { itemId: 'c1', delta: '3 passed' } });
    transcript.apply({
      method: 'item/completed',
      params: { item: { type: 'commandExecution', id: 'c1', status: 'completed', aggregatedOutput: '3 passed' } },
    });
    expect(transcript.activeTurn?.tools[0]).toMatchObject({ status: 'completed', output: '3 passed' });
  });

  it('finishes the active turn and reports busy state', () => {
    const transcript = new SidecarTranscript();
    expect(transcript.busy).toBe(false);
    transcript.apply(turnStarted());
    expect(transcript.busy).toBe(true);
    transcript.apply(turnCompleted());
    expect(transcript.busy).toBe(false);
    expect(transcript.turns).toHaveLength(1);
    expect(transcript.turns[0]?.status).toBe('completed');
  });

  it('closes an unfinished turn when the next one starts', () => {
    const transcript = new SidecarTranscript();
    transcript.apply(turnStarted('t1'));
    transcript.apply(turnStarted('t2'));
    expect(transcript.turns[0]).toMatchObject({ id: 't1', status: 'interrupted' });
    expect(transcript.activeTurn?.id).toBe('t2');
  });

  it('keeps the failure reason from turn/completed', () => {
    const transcript = new SidecarTranscript();
    transcript.apply(turnStarted());
    transcript.apply(turnCompleted('failed', 'provider 401'));
    expect(transcript.turns[0]).toMatchObject({ status: 'failed', error: 'provider 401' });
  });

  it('marks a still-running tool interrupted when the turn is cut short', () => {
    const transcript = new SidecarTranscript();
    transcript.apply(turnStarted());
    transcript.apply({
      method: 'item/started',
      params: { item: { type: 'commandExecution', id: 'c1', displayText: 'x' } },
    });
    transcript.apply(turnCompleted('interrupted'));
    // 记成 completed 会让「被打断的 sleep 60」看起来像正常跑完了。
    expect(transcript.turns[0]?.tools[0]?.status).toBe('interrupted');
  });

  it('marks a still-running tool as failed when the turn fails', () => {
    const transcript = new SidecarTranscript();
    transcript.apply(turnStarted());
    transcript.apply({
      method: 'item/started',
      params: { item: { type: 'commandExecution', id: 'c1', displayText: 'x' } },
    });
    transcript.apply(turnCompleted('failed', 'provider 401'));
    expect(transcript.turns[0]?.tools[0]?.status).toBe('error');
  });

  it('stops re-copying the body once it hits the cap', () => {
    const transcript = new SidecarTranscript();
    transcript.apply(turnStarted());
    transcript.apply(delta('x'.repeat(30_000)));
    const capped = transcript.activeTurn!.text;
    expect(capped).toContain('[截断');
    // 到上限之后的 delta 不再把 24k 字符的正文复制一遍：一条刷屏的回答有几千个
    // delta，旧写法光拼接就要复制几百 MB，而复制出来的部分马上被切掉。
    expect(transcript.apply(delta('y'.repeat(10)))).toBe(false);
    expect(transcript.activeTurn!.text).toBe(capped);
  });

  it('resumes appending when a later completed message is short again', () => {
    const transcript = new SidecarTranscript();
    transcript.apply(turnStarted());
    transcript.apply(delta('x'.repeat(30_000)));
    transcript.apply({
      method: 'item/completed',
      params: { item: { type: 'agentMessage', id: 'm1', text: '短' } },
    });
    expect(transcript.activeTurn?.text).toBe('短');
    expect(transcript.apply(delta('。'))).toBe(true);
    expect(transcript.activeTurn?.text).toBe('短。');
  });

  it('projects token usage and surfaces the last warning once', () => {
    const transcript = new SidecarTranscript();
    transcript.apply({
      method: 'thread/tokenUsage/updated',
      params: {
        tokenUsage: {
          total: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          last: { input_tokens: 80, cached_input_tokens: 10, output_tokens: 20 },
        },
      },
    });
    expect(transcript.usage).toEqual({ input: 100, output: 20, total: 120, contextTokens: 90 });

    transcript.apply({ method: 'warning', params: { warning: { message: 'MCP init failed' } } });
    expect(transcript.takeWarning()).toBe('MCP init failed');
    expect(transcript.takeWarning()).toBe('');
  });

  it('caps the tool list so a long turn cannot pile outputs up in memory', () => {
    const transcript = new SidecarTranscript();
    transcript.apply(turnStarted());
    for (let index = 0; index < 30; index++) {
      transcript.apply({
        method: 'item/started',
        params: { item: { type: 'commandExecution', id: `c${index}`, displayText: `cmd ${index}` } },
      });
    }
    const tools = transcript.activeTurn!.tools;
    expect(tools.length).toBe(20);
    // 丢的是最早的：渲染取最近几条，留下的必须是这一轮最新的进度。
    expect(tools.at(-1)?.id).toBe('c29');
    expect(tools[0]?.id).toBe('c10');
  });

  it('bumps revision on every visible change so pollers can tell nothing happened', () => {
    const transcript = new SidecarTranscript();
    const initial = transcript.revision;
    // 不认识的通知不算变化：不能因为协议里混进别的帧就让父会话重读一份全文。
    expect(transcript.apply({ method: 'thread/started', params: {} })).toBe(false);
    expect(transcript.revision).toBe(initial);

    transcript.apply(turnStarted());
    expect(transcript.revision).toBe(initial + 1);
    transcript.apply(delta('开始'));
    expect(transcript.revision).toBe(initial + 2);
  });

  it('drops the oldest turns past the retention window', () => {
    const transcript = new SidecarTranscript();
    for (let index = 0; index < 25; index++) {
      transcript.apply(turnStarted(`t${index}`));
      transcript.apply(turnCompleted());
    }
    expect(transcript.turns).toHaveLength(20);
    expect(transcript.turns.at(-1)?.id).toBe('t24');
  });
});

describe('renderSidecar', () => {
  it('renders only the latest turn and clips the body', () => {
    const transcript = new SidecarTranscript();
    transcript.apply(turnStarted('t1'));
    transcript.apply(delta('第一轮'));
    transcript.apply(turnCompleted());
    transcript.apply(turnStarted('t2'));
    transcript.apply(delta('x'.repeat(9000)));
    transcript.apply(turnCompleted());

    const text = renderSidecar(fakeEntry(transcript));
    expect(text).toContain('最近一轮');
    // 正文被截断：投影不是审计日志，原文留在子会话自己的对话记录里。
    expect(text.length).toBeLessThan(4200);
    expect(text).not.toContain('第一轮');
  });

  it('only mentions earlier turns when asked for the full view', () => {
    const transcript = new SidecarTranscript();
    transcript.apply(turnStarted('t1'));
    transcript.apply(delta('第一轮结论'));
    transcript.apply(turnCompleted());
    transcript.apply(turnStarted('t2'));
    transcript.apply(delta('第二轮结论'));
    transcript.apply(turnCompleted());

    const entry = fakeEntry(transcript);
    expect(renderSidecar(entry)).not.toContain('第一轮结论');
    expect(renderSidecar(entry, { full: true })).toContain('第一轮结论');
  });

  it('repeats only one line when nothing changed since the last read', () => {
    const transcript = new SidecarTranscript();
    transcript.apply(turnStarted());
    transcript.apply(delta('正在跑测试'));
    const entry = fakeEntry(transcript);

    const first = renderSidecar(entry, { quietWhenUnchanged: true });
    expect(first).toContain('正在跑测试');

    // 这是整个能力最容易被忽略的成本：反复查进度不该反复付 token。
    const second = renderSidecar(entry, { quietWhenUnchanged: true });
    expect(second).toBe('会话 child-1 · 运行中 · 自上次查看后没有新输出。');
    expect(second.length).toBeLessThan(60);

    transcript.apply(delta('，通过了'));
    expect(renderSidecar(entry, { quietWhenUnchanged: true })).toContain('正在跑测试，通过了');
  });

  it('still renders the full projection when the caller did not ask for quiet', () => {
    const transcript = new SidecarTranscript();
    transcript.apply(turnStarted());
    transcript.apply(delta('正在跑测试'));
    const entry = fakeEntry(transcript);
    expect(renderSidecar(entry)).toContain('正在跑测试');
    // sidecar_wait 等到结果时给的就是这一份：模型等的就是它。
    expect(renderSidecar(entry)).toContain('正在跑测试');
  });

  it('never swallows a host warning into the quiet path', () => {
    const transcript = new SidecarTranscript();
    transcript.apply(turnStarted());
    transcript.apply(delta('跑着'));
    const entry = fakeEntry(transcript);
    renderSidecar(entry, { quietWhenUnchanged: true });

    transcript.apply({ method: 'warning', params: { warning: { message: 'MCP init failed' } } });
    // 警告只读一次就清空；被安静路径吃掉等于用户永远看不到这条故障。
    expect(renderSidecar(entry, { quietWhenUnchanged: true })).toContain('MCP init failed');
  });
});

describe('waitSatisfied', () => {
  it('waits for idle only once a turn has actually finished', () => {
    const transcript = new SidecarTranscript();
    expect(waitSatisfied(transcript, 'idle', null, waitBaseline(transcript)).done).toBe(true);
    transcript.apply(turnStarted());
    expect(waitSatisfied(transcript, 'idle', null, waitBaseline(transcript)).done).toBe(false);
    transcript.apply(turnCompleted());
    expect(waitSatisfied(transcript, 'idle', null, waitBaseline(transcript)).done).toBe(true);
  });

  it('does not call it idle while a steer is still waiting to be consumed', () => {
    // 真实时序：send 之后这一轮刚好收尾，那条追加要等下一轮才被消费。只看 busy
    // 的等待会在这里返回，拿到的是不含追加的结果。
    const transcript = new SidecarTranscript();
    transcript.apply(turnStarted('t1'));
    const baseline = waitBaseline(transcript);
    transcript.recordUserInput('追加一句');
    transcript.apply(turnCompleted());
    expect(transcript.busy).toBe(false);
    expect(waitSatisfied(transcript, 'idle', null, baseline).done).toBe(false);
    transcript.apply(turnStarted('t2'));
    expect(waitSatisfied(transcript, 'idle', null, baseline).done).toBe(false);
    transcript.apply(turnCompleted());
    expect(waitSatisfied(transcript, 'idle', null, baseline).done).toBe(true);
  });

  it('matches the latest full text, including output already present when the wait starts', () => {
    const transcript = new SidecarTranscript();
    transcript.apply(turnStarted());
    transcript.apply(delta('构建失败：找不到模块 a'));
    expect(waitSatisfied(transcript, 'text', /构建失败/, waitBaseline(transcript)).done).toBe(true);

    const baseline = waitBaseline(transcript);
    transcript.apply(delta('，改完重新构建成功'));
    expect(waitSatisfied(transcript, 'text', /重新构建成功/, baseline)).toMatchObject({ done: true });
    expect(waitSatisfied(transcript, 'text', /找不到模块/, baseline).done).toBe(true);
    expect(waitSatisfied(transcript, 'text', /模块 a，改完/, baseline).done).toBe(true);
    transcript.apply(turnCompleted());
    expect(waitSatisfied(transcript, 'text', /重新构建成功/, waitBaseline(transcript)).done).toBe(true);
  });

  it('waits for a new finished turn when asked for turn', () => {
    const transcript = new SidecarTranscript();
    transcript.apply(turnStarted());
    transcript.apply(turnCompleted());
    // baseline 是开始等待时的快照：再等一轮。
    const baseline = waitBaseline(transcript);
    expect(waitSatisfied(transcript, 'turn', null, baseline).done).toBe(false);
    transcript.apply(turnStarted('t2'));
    expect(waitSatisfied(transcript, 'turn', null, baseline).done).toBe(false);
    transcript.apply(turnCompleted());
    expect(waitSatisfied(transcript, 'turn', null, baseline).done).toBe(true);
  });

  it('counts a turn absorbed by the running one as the awaited turn', () => {
    // steer 被当前轮的下一迭代吸收时不会产生新轮次：用「轮次数量变多」判断会一直
    // 等不到，只能耗满超时。
    const transcript = new SidecarTranscript();
    transcript.apply(turnStarted('t1'));
    const baseline = waitBaseline(transcript);
    transcript.recordUserInput('追加');
    transcript.apply({ method: 'mica/queue/dequeue', params: { input: { text: '追加' } } });
    expect(transcript.pendingInputCount).toBe(0);
    transcript.apply(turnCompleted());
    expect(waitSatisfied(transcript, 'turn', null, baseline).done).toBe(true);
  });

  it('keeps counting turns past the retention window', () => {
    // 只保留最近 20 轮：拿 turns.length 当基线，第 21 轮之后的等待永远等不到。
    const transcript = new SidecarTranscript();
    for (let index = 0; index < 25; index++) {
      transcript.apply(turnStarted(`t${index}`));
      transcript.apply(turnCompleted());
    }
    expect(transcript.turns).toHaveLength(20);
    expect(transcript.finishedTurnCount).toBe(25);
    const baseline = waitBaseline(transcript);
    transcript.apply(turnStarted('t25'));
    transcript.apply(turnCompleted());
    expect(waitSatisfied(transcript, 'turn', null, baseline).done).toBe(true);
  });
});
