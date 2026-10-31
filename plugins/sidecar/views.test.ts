import { describe, expect, it } from 'vitest';
import type { SidecarEntry } from './registry.js';
import { SidecarTranscript } from './transcript.js';
import { grepTranscript, renderTranscript, renderTurnIndex } from './views.js';

const turnStarted = (id = 't1') => ({ method: 'turn/started', params: { turn: { id } } });
const turnCompleted = (status = 'completed') => ({
  method: 'turn/completed',
  params: { turn: { id: 't1', status } },
});
const toolStarted = (id: string, title: string) => ({
  method: 'item/started',
  params: { item: { type: 'commandExecution', id, displayText: title } },
});

function entryFor(transcript: SidecarTranscript): SidecarEntry {
  return {
    id: 'child-1',
    title: 'probe',
    cwd: '/tmp',
    createdAt: Date.now(),
    process: { transcript, closed: false, describeFailure: () => '' },
  } as unknown as SidecarEntry;
}

/** 跑一轮：投一句话，中间调一个工具，最后给一段正文。 */
function completeTurn(transcript: SidecarTranscript, question: string, answer: string, id = 't1') {
  transcript.recordUserInput(question);
  transcript.apply(turnStarted(id));
  transcript.apply(toolStarted(`c-${id}`, 'run_shell bun run test'));
  transcript.apply({ method: 'item/agentMessage/delta', params: { delta: answer } });
  transcript.apply(turnCompleted());
}

describe('user inputs', () => {
  it('attaches a recorded input to the turn it caused', () => {
    const transcript = new SidecarTranscript();
    transcript.recordUserInput('跑一遍测试');
    transcript.apply(turnStarted());
    expect(transcript.activeTurn?.userInputs.map((input) => input.text)).toEqual(['跑一遍测试']);
    // 归属之后就清空，不会串到下一轮。
    transcript.apply(turnCompleted());
    transcript.apply(turnStarted('t2'));
    expect(transcript.activeTurn?.userInputs).toEqual([]);
  });

  it('keeps a steer pending until the host dequeues it', () => {
    const transcript = new SidecarTranscript();
    transcript.recordUserInput('第一句');
    transcript.apply(turnStarted());
    transcript.recordUserInput('补充一句');
    // after_iteration 的消息可能落进下一轮，发出去那一刻无从判断，先不归属。
    expect(transcript.activeTurn?.userInputs.map((input) => input.text)).toEqual(['第一句']);

    const claimed = transcript.apply({
      method: 'mica/queue/dequeue',
      params: { input: { id: 'q1', text: '补充一句' } },
    });
    expect(claimed).toBe(true);
    expect(transcript.activeTurn?.userInputs.map((input) => input.text)).toEqual(['第一句', '补充一句']);
  });

  it('moves a steer to the next turn when the current one already finished', () => {
    const transcript = new SidecarTranscript();
    transcript.recordUserInput('第一句');
    transcript.apply(turnStarted('t1'));
    transcript.recordUserInput('补充一句');
    transcript.apply(turnCompleted());

    // 这一轮结束了才被消费：不能塞回已收尾的上一轮，否则对话里就是「问了却没答」。
    expect(transcript.apply({ method: 'mica/queue/dequeue', params: { input: { text: '补充一句' } } })).toBe(false);
    transcript.apply(turnStarted('t2'));
    expect(transcript.activeTurn?.userInputs.map((input) => input.text)).toEqual(['补充一句']);
  });

  it('drops an input whose request never went out', () => {
    const transcript = new SidecarTranscript();
    const token = transcript.recordUserInput('这条没发出去');
    transcript.dropUserInput(token);
    transcript.apply(turnStarted());
    // 发失败的消息不能留在对话里：读起来像用户说过一句它其实没收到的话。
    expect(transcript.activeTurn?.userInputs).toEqual([]);
  });

  it('counts a new input as a visible change so status stops being quiet', () => {
    const transcript = new SidecarTranscript();
    const before = transcript.revision;
    transcript.recordUserInput('新的一句话');
    expect(transcript.revision).toBeGreaterThan(before);
  });
});

describe('renderTranscript', () => {
  it('shows the conversation without tools or thinking', () => {
    const transcript = new SidecarTranscript();
    completeTurn(transcript, '跑一遍测试', '三个用例失败：module-a');
    const text = renderTranscript(entryFor(transcript));

    expect(text).toContain('[用户] 跑一遍测试');
    expect(text).toContain('[助手] 三个用例失败：module-a');
    // 工具行与思考不属于「对话」：要看它们是 sidecar_status 的事。
    expect(text).not.toContain('run_shell bun run test');
    expect(text).not.toContain('工具调用');
  });

  it('can leave the user side out when only the answer matters', () => {
    const transcript = new SidecarTranscript();
    completeTurn(transcript, '跑一遍测试', '三个用例失败');
    const text = renderTranscript(entryFor(transcript), { includeUser: false });
    expect(text).not.toContain('跑一遍测试');
    expect(text).toContain('三个用例失败');
  });

  it('reads only the latest turn by default', () => {
    const transcript = new SidecarTranscript();
    completeTurn(transcript, '第一问', '第一答', 't1');
    completeTurn(transcript, '第二问', '第二答', 't2');

    const one = renderTranscript(entryFor(transcript));
    expect(one).toContain('第二答');
    expect(one).not.toContain('第一答');

    const both = renderTranscript(entryFor(transcript), { lastTurns: 2 });
    expect(both).toContain('第一答');
    expect(both).toContain('第二答');
  });

  it('stops at the character budget and says how much it skipped', () => {
    const transcript = new SidecarTranscript();
    for (let index = 0; index < 4; index++) {
      completeTurn(transcript, `问 ${index}`, '答'.repeat(3_000), `t${index}`);
    }
    const text = renderTranscript(entryFor(transcript), { lastTurns: 4, maxChars: 5_000 });

    // 预算比总内容小得多：必须截断，而且不能悄悄截——丢了几轮要写出来。
    expect(text.length).toBeLessThan(6_500);
    expect(text).toContain('没放进来');
    // 保新丢旧：最新一轮必须在，最早那轮被预算挤掉。
    expect(text).toContain('问 3');
    expect(text).not.toContain('问 0');
  });

  it('counts questions, errors and headings against the total character budget', () => {
    const transcript = new SidecarTranscript();
    for (let index = 0; index < 4; index++) {
      completeTurn(transcript, `最新问题 ${index}\n${'问'.repeat(2_000)}`, '答'.repeat(6_000), `t${index}`);
      transcript.turns.at(-1)!.error = '错误'.repeat(2_000);
    }
    for (const maxChars of [240, 500, 2_000, 5_000]) {
      const text = renderTranscript(entryFor(transcript), { lastTurns: 4, maxChars });
      expect(text.length).toBeLessThanOrEqual(maxChars);
      expect(text).toContain('[助手]');
      expect(text).not.toContain('最新问题 0');
    }
  });

  it('handles a session that has not said anything yet', () => {
    expect(renderTranscript(entryFor(new SidecarTranscript()))).toContain('还没有任何一轮对话');
  });
});

describe('renderTurnIndex', () => {
  it('gives one line per turn with its question and answer', () => {
    const transcript = new SidecarTranscript();
    completeTurn(transcript, '跑一遍测试', '三个用例失败', 't1');
    completeTurn(transcript, '修一下它们', '已经修好', 't2');
    const text = renderTurnIndex(entryFor(transcript));

    expect(text).toContain('共 2 轮');
    expect(text).toContain('问：跑一遍测试');
    expect(text).toContain('答：已经修好');
    // 索引是索引：不能把正文全文搬进来。
    expect(text.length).toBeLessThan(1_200);
  });

  it('honours limit and numbers the turns from the whole list', () => {
    const transcript = new SidecarTranscript();
    for (let index = 0; index < 3; index++) {
      completeTurn(transcript, `问 ${index}`, `答 ${index}`, `t${index}`);
    }
    const text = renderTurnIndex(entryFor(transcript), { limit: 2 });
    expect(text).toContain('只列最近 2 轮');
    // 只列最后两轮，但编号仍然是 2 / 3——否则读的人会以为第一轮就是它。
    expect(text).toContain('  2 ·');
    expect(text).toContain('  3 ·');
    expect(text).not.toContain('  1 ·');
  });
});

describe('grepTranscript', () => {
  it('returns matching lines with the turn and speaker', () => {
    const transcript = new SidecarTranscript();
    completeTurn(transcript, '查一下为什么挂', '报错是 Cannot find module a', 't1');
    completeTurn(transcript, '再查一次', '还是 Cannot find module a', 't2');

    const text = grepTranscript(entryFor(transcript), { pattern: /Cannot find module/ });
    expect(text).toContain('命中 2 处');
    expect(text).toContain('[第1轮 · 助手]');
    expect(text).toContain('[第2轮 · 助手]');
  });

  it('searches what the user said as well', () => {
    const transcript = new SidecarTranscript();
    completeTurn(transcript, '只看 module-a 那个包', '好的', 't1');
    expect(grepTranscript(entryFor(transcript), { pattern: /module-a/ })).toContain('[第1轮 · 用户]');
  });

  it('caps the matches and reports the remainder', () => {
    const transcript = new SidecarTranscript();
    const noisy = Array.from({ length: 20 }, (_, index) => `第 ${index} 行命中 target`).join('\n');
    completeTurn(transcript, '一堆命中', noisy, 't1');

    const text = grepTranscript(entryFor(transcript), { pattern: /target/, maxMatches: 3 });
    expect(text).toContain('命中 20 处');
    expect(text).toContain('另有 17 处未列出');
  });

  it('does not skip lines when the pattern carries the g flag', () => {
    const transcript = new SidecarTranscript();
    completeTurn(transcript, 'q', 'hit\nhit\nhit', 't1');
    // 带 g 的正则 test() 有 lastIndex 状态，逐行匹配会隔行漏；这里必须 3 处全中。
    expect(grepTranscript(entryFor(transcript), { pattern: /hit/g })).toContain('命中 3 处');
  });

  it('says so when nothing matches', () => {
    const transcript = new SidecarTranscript();
    completeTurn(transcript, '问', '答', 't1');
    expect(grepTranscript(entryFor(transcript), { pattern: /不存在的东西/ })).toContain('没有命中');
  });

  it('bounds excerpts even when a wildcard matches an entire long line', () => {
    const transcript = new SidecarTranscript();
    completeTurn(transcript, 'q', 'x'.repeat(24_000));
    expect(grepTranscript(entryFor(transcript), { pattern: /.*/ }).length).toBeLessThan(500);
  });
});
