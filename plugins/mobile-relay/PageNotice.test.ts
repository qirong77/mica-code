import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acknowledgePageNotice, markPageNoticeSeen, pageNoticeKey, readPageNotice } from './PageNotice.js';

/**
 * 提示点的一次性语义：同一对「本机版 vs 中转机版」只提示一次。
 *
 * 页面落后能持续几天，状态每 3 秒重算一次；不去重的话侧栏那枚点永远关不掉。
 */

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mica-page-notice-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeStatus(status: Record<string, unknown>): void {
  writeFileSync(join(dir, 'data.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf8');
}

function readStatus(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8')) as Record<string, unknown>;
}

describe('pageNoticeKey', () => {
  it('needs both sides to form a comparison', () => {
    expect(pageNoticeKey('aaa', 'bbb')).toBe('aaa->bbb');
    expect(pageNoticeKey('', 'bbb')).toBe('');
    expect(pageNoticeKey('aaa', '')).toBe('');
  });
});

describe('readPageNotice', () => {
  it('starts empty and tolerates a missing or broken file', () => {
    expect(readPageNotice(dir).seen).toEqual([]);
    writeFileSync(join(dir, 'page-notice.json'), '{oops', 'utf8');
    expect(readPageNotice(dir).seen).toEqual([]);
    expect(readPageNotice(null).seen).toEqual([]);
  });

  it('only keeps entries that look like a comparison', () => {
    writeFileSync(join(dir, 'page-notice.json'), JSON.stringify({ seen: ['a->b', 7, '', 'c'] }), 'utf8');
    expect(readPageNotice(dir).seen).toEqual(['a->b']);
  });
});

describe('markPageNoticeSeen', () => {
  it('records a key once and keeps the newest few', () => {
    expect(markPageNoticeSeen(dir, 'a->b')).toBe(true);
    expect(markPageNoticeSeen(dir, 'a->b')).toBe(false);
    expect(readPageNotice(dir).seen).toEqual(['a->b']);

    for (let index = 0; index < 12; index += 1) markPageNoticeSeen(dir, `v${index}->r${index}`);
    const { seen } = readPageNotice(dir);
    expect(seen.length).toBeLessThanOrEqual(8);
    expect(seen.at(-1)).toBe('v11->r11');
    expect(seen).not.toContain('a->b');
  });

  it('ignores an empty key or a missing directory', () => {
    expect(markPageNoticeSeen(dir, '')).toBe(false);
    expect(markPageNoticeSeen(null, 'a->b')).toBe(false);
  });
});

describe('acknowledgePageNotice', () => {
  // 点一下动作之后要「立刻」没有红点：常驻监管 3 秒才重算一次，等它刷用户会以为没生效。
  it('records the pair and clears the attention already written to data.json', () => {
    writeStatus({
      pageKey: 'local1->remote2',
      attention: { text: '手机端页面落后', tone: 'warn', action: 'sync-page' },
      bridge: { text: '运行中 · pid 1', tone: 'ok' },
    });

    expect(acknowledgePageNotice(dir)).toBe('local1->remote2');
    expect(readPageNotice(dir).seen).toEqual(['local1->remote2']);
    const status = readStatus();
    expect(status.attention).toBeNull();
    // 其余状态行原样保留：写的是自己的数据文件，不是整份重造。
    expect(status.pageKey).toBe('local1->remote2');
    expect(status.bridge).toEqual({ text: '运行中 · pid 1', tone: 'ok' });
  });

  it('does nothing when there is no comparison to record', () => {
    writeStatus({ pageKey: '', attention: null });
    expect(acknowledgePageNotice(dir)).toBe('');
    expect(readPageNotice(dir).seen).toEqual([]);
    expect(acknowledgePageNotice(null)).toBe('');
  });

  it('keeps data.json untouched when nothing was reported', () => {
    writeStatus({ pageKey: 'local1->remote2' });
    expect(acknowledgePageNotice(dir)).toBe('local1->remote2');
    expect(readStatus()).toEqual({ pageKey: 'local1->remote2' });
  });
});
