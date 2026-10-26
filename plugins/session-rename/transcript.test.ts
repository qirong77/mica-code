import { describe, expect, it } from 'vitest';
import { buildTranscript, formatTranscript, messageText } from './transcript.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';

const user = (text: string, extra: Partial<{ displayContent: string }> = {}): MicaUiConversationMessage => ({
  role: 'user',
  content: text,
  ...extra,
});
const assistant = (text: string): MicaUiConversationMessage => ({ role: 'assistant', content: text });

describe('buildTranscript', () => {
  it('keeps user and assistant text only', () => {
    const entries = buildTranscript(
      [user('修一下登录超时'), assistant('看了下是 fetch 没设置 timeout'), { role: 'notice', content: '工具报错' }],
      { maxMessages: 10 },
    );

    expect(entries).toEqual([
      { role: 'user', text: '修一下登录超时' },
      { role: 'assistant', text: '看了下是 fetch 没设置 timeout' },
    ]);
  });

  it('drops plugin-injected prompts, whose display text differs from what was sent', () => {
    const entries = buildTranscript(
      [user('[git diff]\ndiff --git ...', { displayContent: '已发送 3 个文件的 diff' }), assistant('总结：改了鉴权')],
      { maxMessages: 10 },
    );

    expect(entries).toEqual([{ role: 'assistant', text: '总结：改了鉴权' }]);
  });

  it('drops compact boundaries and summaries', () => {
    const entries = buildTranscript(
      [
        user('[Mica compact boundary]\n{"coverage":"messages 1-20"}'),
        user('[Mica compact checkpoint]\n\nThis session is being continued.'),
        user('继续改压缩策略'),
        assistant('好'),
      ],
      { maxMessages: 10 },
    );

    expect(entries.map((entry) => entry.text)).toEqual(['继续改压缩策略', '好']);
  });

  it('strips image placeholders and keeps the last N entries', () => {
    const entries = buildTranscript(
      [user('[Image](/tmp/a.png) 看下这张图'), assistant('图里是报错'), user('那就修'), assistant('改了')],
      { maxMessages: 2 },
    );

    expect(entries).toEqual([
      { role: 'user', text: '那就修' },
      { role: 'assistant', text: '改了' },
    ]);
  });

  it('joins text blocks and skips empty messages', () => {
    const entries = buildTranscript(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: '第一段' },
            { type: 'text', text: '第二段' },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }],
        },
        assistant('   '),
      ],
      { maxMessages: 10 },
    );

    expect(entries).toEqual([{ role: 'user', text: '第一段\n第二段' }]);
  });

  it('truncates a single long message instead of dropping it', () => {
    const entries = buildTranscript([user('x'.repeat(50))], { maxMessages: 5, maxCharsPerMessage: 10 });
    expect(entries[0]?.text).toBe('xxxxxxxxxx…');
  });
});

describe('formatTranscript', () => {
  it('labels the two speakers so the model can tell them apart', () => {
    expect(
      formatTranscript([
        { role: 'user', text: '问题' },
        { role: 'assistant', text: '答案' },
      ]),
    ).toBe('用户：问题\n\n助手：答案');
  });
});

describe('messageText', () => {
  it('normalizes trailing whitespace', () => {
    expect(messageText('第一行   \n第二行\t')).toBe('第一行\n第二行');
  });
});
