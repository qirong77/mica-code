import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOOP_INTERVAL_MS,
  MAX_LOOP_INTERVAL_MS,
  MIN_LOOP_INTERVAL_MS,
  formatLoopInterval,
  parseLoopArgs,
  parseLoopDuration,
} from '../loopArgs.js';

describe('parseLoopDuration', () => {
  it('parses single units', () => {
    expect(parseLoopDuration('60m')).toBe(3_600_000);
    expect(parseLoopDuration('30s')).toBe(30_000);
    expect(parseLoopDuration('2h')).toBe(7_200_000);
    expect(parseLoopDuration('1d')).toBe(86_400_000);
  });

  it('parses compound and fractional intervals', () => {
    expect(parseLoopDuration('1h30m')).toBe(5_400_000);
    expect(parseLoopDuration('1.5h')).toBe(5_400_000);
  });

  it('accepts long unit words, which the composer examples rely on', () => {
    expect(parseLoopDuration('30min')).toBe(1_800_000);
    expect(parseLoopDuration('60min')).toBe(3_600_000);
    expect(parseLoopDuration('15 mins')).toBe(900_000);
    expect(parseLoopDuration('2hours')).toBe(7_200_000);
    expect(parseLoopDuration('1 hour 30 minutes')).toBe(5_400_000);
  });

  it('treats a bare number as seconds', () => {
    expect(parseLoopDuration('90')).toBe(90_000);
    expect(parseLoopDuration('0')).toBe(0);
  });

  it('rejects input that is not fully consumed', () => {
    expect(parseLoopDuration('')).toBeNull();
    expect(parseLoopDuration('abc')).toBeNull();
    expect(parseLoopDuration('m')).toBeNull();
    expect(parseLoopDuration('60x')).toBeNull();
    expect(parseLoopDuration('h1m')).toBeNull();
  });
});

describe('formatLoopInterval', () => {
  it('scales the unit with the interval', () => {
    expect(formatLoopInterval(30_000)).toBe('30 秒');
    expect(formatLoopInterval(5 * 60_000)).toBe('5 分钟');
    expect(formatLoopInterval(2 * 3_600_000)).toBe('2 小时');
    expect(formatLoopInterval(3 * 86_400_000)).toBe('3 天');
  });
});

describe('parseLoopArgs', () => {
  it('reports status and stop for the control words', () => {
    expect(parseLoopArgs('')).toEqual({ kind: 'status' });
    expect(parseLoopArgs('status')).toEqual({ kind: 'status' });
    for (const word of ['stop', 'off', 'cancel', 'end']) {
      expect(parseLoopArgs(word.toUpperCase())).toEqual({ kind: 'stop' });
    }
  });

  it('starts with an explicit interval', () => {
    expect(parseLoopArgs('30min 推送一条 AI 新闻')).toEqual({
      kind: 'start',
      intervalMs: 1_800_000,
      intervalLabel: '30 分钟',
      task: '推送一条 AI 新闻',
    });
  });

  it('falls back to the default interval and keeps the whole input as the task', () => {
    expect(parseLoopArgs('推送一个 BBC 的新闻')).toEqual({
      kind: 'start',
      intervalMs: DEFAULT_LOOP_INTERVAL_MS,
      intervalLabel: '30 分钟',
      task: '推送一个 BBC 的新闻',
    });
  });

  it('treats a leading number as part of the task when no unit follows', () => {
    expect(parseLoopArgs('把 3 个 Issue 汇总')).toMatchObject({
      kind: 'start',
      intervalMs: DEFAULT_LOOP_INTERVAL_MS,
      task: '把 3 个 Issue 汇总',
    });
  });

  it('rejects a missing task and an interval below the floor', () => {
    expect(parseLoopArgs('30m')).toMatchObject({ kind: 'error' });
    expect(parseLoopArgs('5s 太短了')).toMatchObject({ kind: 'error' });
    expect(MIN_LOOP_INTERVAL_MS).toBe(10_000);
  });

  it('keeps the desktop overflow cap above the CLI default', () => {
    expect(MAX_LOOP_INTERVAL_MS).toBe(7 * 24 * 3_600_000);
    expect(MAX_LOOP_INTERVAL_MS).toBeGreaterThan(DEFAULT_LOOP_INTERVAL_MS);
  });
});
