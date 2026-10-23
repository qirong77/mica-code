import { describe, expect, it } from 'vitest';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import { TurnNoticeLog, createRetryNotice, createTurnErrorNotice, type TurnNotice } from './turnNotices.js';

function notice(content: string, command = '/note'): TurnNotice {
  return { role: 'notice', content, variant: 'error', command };
}

describe('TurnNoticeLog', () => {
  it('threads notices back to the position they were created at', () => {
    const base: MicaUiConversationMessage[] = [];
    const log = new TurnNoticeLog(() => base);
    base.push({ role: 'user', content: 'one' });
    log.append(notice('failed turn 1'));
    base.push({ role: 'assistant', content: 'answer 1' });
    base.push({ role: 'user', content: 'two' });
    log.append(notice('failed turn 2'));
    base.push({ role: 'assistant', content: 'answer 2' });

    expect(log.compose().map((message) => message.content)).toEqual([
      'one',
      'failed turn 1',
      'answer 1',
      'two',
      'failed turn 2',
      'answer 2',
    ]);
  });

  it('restores notices from a persisted conversation and keeps their order', () => {
    const base: MicaUiConversationMessage[] = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'answer 1' },
      { role: 'user', content: 'two' },
    ];
    const log = new TurnNoticeLog(() => base);
    log.restore([
      { role: 'user', content: 'one' },
      { role: 'notice', content: 'failed', variant: 'error', command: '/error' },
      { role: 'assistant', content: 'answer 1' },
      { role: 'user', content: 'two' },
    ]);

    expect(log.compose().map((message) => message.content)).toEqual(['one', 'failed', 'answer 1', 'two']);
    expect(log.compose()[1]).toMatchObject({ role: 'notice', variant: 'error', command: '/error' });
  });

  it('updates a repeated notice for the same turn in place', () => {
    const base: MicaUiConversationMessage[] = [{ role: 'user', content: 'one' }];
    const log = new TurnNoticeLog(() => base);
    log.upsert(notice('retry 1', '/retry'));
    log.upsert(notice('retry 2', '/retry'));

    expect(log.size).toBe(1);
    expect(log.compose().map((message) => message.content)).toEqual(['one', 'retry 2']);
  });

  it('replaces a running progress notice wherever it sits', () => {
    const base: MicaUiConversationMessage[] = [{ role: 'user', content: 'one' }];
    const log = new TurnNoticeLog(() => base);
    log.upsert({ role: 'notice', content: 'compacting', variant: 'compact', command: '/compact', status: 'running' });
    base.push({ role: 'assistant', content: 'answer' });
    log.upsert({ role: 'notice', content: 'compacted', variant: 'compact', command: '/compact', status: 'success' });

    expect(log.size).toBe(1);
    expect(log.compose().map((message) => message.content)).toEqual(['one', 'compacted', 'answer']);
  });

  it('clamps notices when the history shrank', () => {
    const base: MicaUiConversationMessage[] = [{ role: 'user', content: 'one' }];
    const log = new TurnNoticeLog(() => base);
    log.restore([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'two' },
      { role: 'notice', content: 'late', variant: 'error', command: '/error' },
    ]);

    expect(log.compose().map((message) => message.content)).toEqual(['one', 'late']);
  });

  it('keeps a turn notice behind the in-flight prompt', () => {
    const base: MicaUiConversationMessage[] = [
      { role: 'user', content: 'previous' },
      { role: 'assistant', content: 'answer' },
    ];
    const log = new TurnNoticeLog(() => base);
    log.upsert(notice('retry', '/retry'));

    const composed = log.compose([{ role: 'user', content: 'pending' }]);
    expect(composed.map((message) => message.content)).toEqual(['previous', 'answer', 'pending', 'retry']);
  });

  it('drops the notices on clear', () => {
    const log = new TurnNoticeLog(() => [{ role: 'user', content: 'one' }]);
    log.append(notice('failed'));
    log.clear();
    expect(log.size).toBe(0);
    expect(log.compose()).toHaveLength(1);
  });

  it('ignores malformed persisted notices', () => {
    const log = new TurnNoticeLog(() => []);
    log.restore([{ role: 'notice' }, { role: 'notice', content: '' }, null, 'junk', { role: 'user', content: 'hi' }]);
    expect(log.size).toBe(0);
  });
});

describe('notice message builders', () => {
  it('formats the retry hint with the attempt and the delay', () => {
    expect(createRetryNotice(new Error('socket closed'), 2, 5, 10_000)).toEqual({
      role: 'notice',
      content: '请求暂时失败，将在 10s 后自动重试（第 2/5 次）\n错误：socket closed',
      variant: 'error',
      command: '/retry',
    });
  });

  it('formats the final failure', () => {
    expect(createTurnErrorNotice('boom')).toEqual({
      role: 'notice',
      content: '请求失败: boom',
      variant: 'error',
      command: '/error',
    });
  });
});
