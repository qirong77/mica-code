import { describe, expect, it } from 'vitest';
import {
  MAX_TURN_TIMINGS,
  type TurnTimingRecord,
  appendTurnTiming,
  applyTurnTimingTick,
  createTurnTimingState,
  normalizeTurnTimings,
  summarizeTurnTiming,
  turnTimingRecord,
  turnTimingStateFromRecord,
} from './turnTiming.js';

function runOneTurn(): ReturnType<typeof createTurnTimingState> {
  let state = applyTurnTimingTick(createTurnTimingState(), { type: 'turn-start', at: 1_000 });
  state = applyTurnTimingTick(state, { type: 'output', at: 1_400, chars: 40 });
  state = applyTurnTimingTick(state, { type: 'output', at: 1_900, chars: 60 });
  state = applyTurnTimingTick(state, {
    type: 'tool-start',
    at: 2_000,
    tool: 'run_shell',
    callID: 'a',
    displayText: 'bun test',
  });
  state = applyTurnTimingTick(state, { type: 'tool-end', at: 3_200, callID: 'a' });
  return applyTurnTimingTick(state, { type: 'turn-end', at: 3_500, outcome: 'completed' });
}

describe('turn timing persistence', () => {
  it('round-trips a finished turn through the persisted shape', () => {
    const state = runOneTurn();
    const record = turnTimingRecord(state);
    expect(record).not.toBeNull();
    expect(record!.outcome).toBe('completed');

    const summary = summarizeTurnTiming(turnTimingStateFromRecord(record!));
    expect(summary!.totalMs).toBe(2_500);
    // 收尾那条等待随记录一起落盘：不算一次请求，界面上也要能认出它不是首字等待。
    expect(summary!.requests).toBe(1);
    expect(summary!.timeline.at(-1)).toMatchObject({ kind: 'wait', tail: true });
    expect(summary!.percents.reduce((sum, value) => sum + value, 0)).toBe(100);
    // 收尾那 300ms（工具回来后到这一轮结束）也算等待，所以末尾还有一条 wait。
    expect(summary!.timeline.map((item) => item.kind)).toEqual(['wait', 'generate', 'tool', 'wait']);
    expect(summary!.toolCalls).toBe(1);
  });

  it('has no record while the turn is still running', () => {
    const state = applyTurnTimingTick(createTurnTimingState(), { type: 'turn-start', at: 1_000 });
    expect(turnTimingRecord(state)).toBeNull();
  });

  it('drops malformed records instead of rejecting the whole list', () => {
    const good = turnTimingRecord(runOneTurn())!;
    const records = normalizeTurnTimings([
      good,
      null,
      { startedAt: 'x' },
      { startedAt: 5, endedAt: 4, segments: [] },
      { startedAt: 10, endedAt: 20, outcome: 'aborted', segments: [{ kind: 'nope', start: 10, end: 20 }] },
    ]);
    expect(records).toHaveLength(2);
    // 排序按起点，坏的段（kind 不认识）被丢掉、记录本身保留。
    expect(records[0]).toEqual({ startedAt: 10, endedAt: 20, outcome: 'aborted', segments: [] });
    expect(records[1]!.startedAt).toBe(1_000);
  });

  it('keeps only the newest rounds once the cap is reached', () => {
    let records: TurnTimingRecord[] = [];
    for (let index = 0; index < MAX_TURN_TIMINGS + 3; index += 1) {
      records = appendTurnTiming(records, {
        startedAt: 1_000 + index,
        endedAt: 1_100 + index,
        outcome: 'completed',
        segments: [],
      });
    }
    expect(records).toHaveLength(MAX_TURN_TIMINGS);
    expect(records[0]!.startedAt).toBe(1_003);
  });

  it('replaces the last round instead of duplicating it when the start time matches', () => {
    const first = { startedAt: 1_000, endedAt: 2_000, outcome: 'completed' as const, segments: [] };
    const retried = { startedAt: 1_000, endedAt: 2_500, outcome: 'error' as const, segments: [] };
    expect(appendTurnTiming([first], retried)).toEqual([retried]);
  });

  it('marks a tool that never came back as aborted', () => {
    let state = applyTurnTimingTick(createTurnTimingState(), { type: 'turn-start', at: 1_000 });
    state = applyTurnTimingTick(state, { type: 'tool-start', at: 1_100, tool: 'run_shell', callID: 'a' });
    state = applyTurnTimingTick(state, { type: 'turn-end', at: 4_000, outcome: 'aborted' });
    const record = turnTimingRecord(state)!;
    expect(record.segments.find((segment) => segment.kind === 'tool')?.status).toBe('aborted');
  });
});
