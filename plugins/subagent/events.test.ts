import { describe, expect, it } from 'vitest';
import { MAX_SUBAGENT_EVENTS, renderSubagentEvents, SubagentEventLog, summarizeTurn } from './events.js';
import type { SubagentTurn } from './transcript.js';

function turn(overrides: Partial<SubagentTurn> = {}): SubagentTurn {
  return {
    id: 't1',
    status: 'completed',
    text: '',
    thinking: '',
    tools: [],
    userInputs: [],
    startedAt: 1,
    finishedAt: 2_000,
    ...overrides,
  };
}

describe('SubagentEventLog', () => {
  it('keeps only the newest events', () => {
    const log = new SubagentEventLog();
    for (let index = 0; index < MAX_SUBAGENT_EVENTS + 5; index++) {
      log.add({ sessionId: `s${index}`, title: 'x', kind: 'turn', summary: `e${index}` });
    }
    // 事件是「动态」，不是审计日志：父会话的上下文比历史记录贵得多。
    expect(log.peek()).toHaveLength(MAX_SUBAGENT_EVENTS);
    expect(log.peek()[0]?.summary).toBe('e5');
  });

  it('hands events out exactly once', () => {
    const log = new SubagentEventLog();
    log.add({ sessionId: 's1', title: 'x', kind: 'turn', summary: '跑完了' });
    expect(log.take()).toHaveLength(1);
    // 读后即清：同一件事在每一轮 prompt 里重复出现会撑上下文、也会打断 prompt cache。
    expect(log.take()).toHaveLength(0);
  });

  it('drops the events of a session that is gone', () => {
    const log = new SubagentEventLog();
    log.add({ sessionId: 's1', title: 'x', kind: 'turn', summary: 'A' });
    log.add({ sessionId: 's2', title: 'y', kind: 'exit', summary: 'B' });
    log.dropSession('s1');
    expect(log.peek().map((event) => event.sessionId)).toEqual(['s2']);
  });
});

describe('summarizeTurn', () => {
  it('takes the tail of the answer, not the opening line', () => {
    const summary = summarizeTurn(
      turn({ text: '我先看看仓库结构\n已经改完了三个文件\n测试全部通过' }),
    );
    expect(summary).toContain('测试全部通过');
  });

  it('counts failed tools so a silent failure is still visible', () => {
    const summary = summarizeTurn(
      turn({
        text: '完成了',
        tools: [
          { id: 'a', title: 'bun run test', status: 'error' },
          { id: 'b', title: 'git status', status: 'completed' },
        ],
      }),
    );
    expect(summary).toContain('1 条工具报错');
  });

  it('falls back to a readable line when there is no body', () => {
    expect(summarizeTurn(turn({ status: 'failed', error: '模型返回 500' }))).toContain('模型返回 500');
  });
});

describe('renderSubagentEvents', () => {
  it('renders nothing when there is nothing new', () => {
    // 空串让整段从 prompt 里消失：没有事件的那些轮次，前缀完全不变。
    expect(renderSubagentEvents([])).toBe('');
  });

  it('lists one line per event with the full id and a next step', () => {
    const log = new SubagentEventLog();
    log.add({
      sessionId: 'abcdef123456',
      title: '跑测试',
      kind: 'turn',
      summary: '完成 · 42s · 全部通过',
    });
    const text = renderSubagentEvents(log.take());
    // 完整 id：真实 id 都以日期开头，截断到 8 位每条都是 "20261125"，
    // 既分不出是谁，也没法拿去当 `subagent_inspect` 的唯一前缀。
    expect(text).toContain('abcdef123456');
    expect(text).toContain('跑测试');
    expect(text).toContain('全部通过');
    expect(text).toContain('subagent_stop');
  });
});
