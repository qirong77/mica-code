import { describe, expect, it } from 'vitest';
import { buildTranscript, formatTitleInput, formatTranscript, messageText } from './transcript.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';

const user = (text: string, extra: Partial<{ displayContent: string }> = {}): MicaUiConversationMessage => ({
  role: 'user',
  content: text,
  ...extra,
});
const assistant = (text: string): MicaUiConversationMessage => ({ role: 'assistant', content: text });

describe('buildTranscript', () => {
  it('only reads the recent messages needed by the title budget in a long history', () => {
    let reads = 0;
    const history = Array.from({ length: 20_000 }, (_, index) => ({
      role: index % 2 ? 'assistant' as const : 'user' as const,
      get content() {
        reads += 1;
        return `message ${index}`;
      },
    }));
    expect(buildTranscript(history, { maxMessages: 12 })).toHaveLength(12);
    expect(reads).toBe(12);
  });

  it('appends repeated words as a new request when the previous user message was answered', () => {
    expect(buildTranscript([user('继续'), assistant('正在排查')], {
      maxMessages: 3,
      latestUserText: '继续',
    })).toEqual([
      { role: 'user', text: '继续' },
      { role: 'assistant', text: '正在排查' },
      { role: 'user', text: '继续' },
    ]);
  });

  it('keeps the same filtered suffix and pending input under different message budgets', () => {
    const history = Array.from({ length: 300 }, (_, index) => index % 7 === 0
      ? user('[Mica compact boundary]\n{}')
      : index % 5 === 0
        ? user('internal prompt', { displayContent: 'plugin notice' })
        : index % 2 ? assistant(`reply ${index}`) : user(`request ${index}`));
    for (const latestUserText of ['', 'next request', 'request 298']) {
      const all = buildTranscript(history, { maxMessages: 0, latestUserText });
      for (const maxMessages of [1, 2, 3, 12, 50]) {
        expect(buildTranscript(history, { maxMessages, latestUserText })).toEqual(all.slice(-maxMessages));
      }
    }
  });

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

  it('appends the in-flight user input, which is not in the history yet', () => {
    const entries = buildTranscript([user('第一轮'), assistant('好')], {
      maxMessages: 10,
      latestUserText: '第二轮：顺便修下登录',
    });

    expect(entries.at(-1)).toEqual({ role: 'user', text: '第二轮：顺便修下登录' });
  });

  it('does not append the in-flight input twice when it is already the last user entry', () => {
    const entries = buildTranscript([user('第一轮'), assistant('好'), user('第二轮')], {
      maxMessages: 10,
      latestUserText: '第二轮',
    });

    expect(entries.filter((entry) => entry.text === '第二轮')).toHaveLength(1);
  });

  it('keeps the in-flight input inside the message budget', () => {
    const entries = buildTranscript([user('旧一'), assistant('旧答'), user('旧二'), assistant('旧答二')], {
      maxMessages: 2,
      latestUserText: '这一轮',
    });

    expect(entries.map((entry) => entry.text)).toEqual(['旧答二', '这一轮']);
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

describe('formatTitleInput', () => {
  it('separates the context from the request the title should describe', () => {
    expect(
      formatTitleInput([
        { role: 'user', text: '重构压缩策略' },
        { role: 'assistant', text: '改完阈值了' },
        { role: 'user', text: '顺便修下登录超时' },
      ]),
    ).toBe(
      [
        '对话记录（从旧到新，仅用于理解上下文）：',
        '用户：重构压缩策略\n\n助手：改完阈值了',
        '',
        '用户最新请求（标题概括这一段）：',
        '用户：顺便修下登录超时',
      ].join('\n'),
    );
  });

  it('falls back to a plain transcript when there is no user message', () => {
    expect(formatTitleInput([{ role: 'assistant', text: '只剩我' }])).toBe('对话记录（从旧到新）：\n助手：只剩我');
  });
});

describe('messageText', () => {
  it('normalizes trailing whitespace', () => {
    expect(messageText('第一行   \n第二行\t')).toBe('第一行\n第二行');
  });
});
