import { describe, expect, it } from 'vitest';
import { comparableContentText, comparableMessageText, comparableText, stripMediaPlaceholders } from '../promptText.js';

describe('stripMediaPlaceholders', () => {
  it('removes every known spelling of an image placeholder, path included', () => {
    expect(stripMediaPlaceholders('看 [Image](~/.mica/images/a.png) 这个')).toBe('看  这个');
    expect(stripMediaPlaceholders('看 [图片] 这个')).toBe('看  这个');
    expect(stripMediaPlaceholders('看 [Image] 这个')).toBe('看  这个');
    expect(stripMediaPlaceholders('看 [image omitted during compact] 这个')).toBe('看  这个');
    expect(stripMediaPlaceholders('看 [image omitted: no such file] 这个')).toBe('看  这个');
  });
});

describe('comparableText', () => {
  it('folds whitespace and drops the media placeholders', () => {
    expect(comparableText('  看\t[图片]\n这个  ')).toBe('看 这个');
    expect(comparableText('[Image](a.png)')).toBe('');
    expect(comparableText('')).toBe('');
    expect(comparableText(undefined)).toBe('');
  });
});

describe('comparableContentText', () => {
  const input = '看 [Image](~/.mica/images/a.png) 这个';

  it('matches the original input for the Responses projection (order preserved)', () => {
    const providerItem = {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '看 ' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        { type: 'input_text', text: ' 这个' },
      ],
    };
    expect(comparableMessageText(providerItem)).toBe(comparableText(input));
    expect(comparableMessageText(providerItem)).toBe('看 这个');
  });

  it('matches the original input for the Chat Completions projection (images collapse to the tail)', () => {
    // ChatCompletionsClient.toConversationMessages 把所有图片兜底文本并为末尾一个
    // 文本块：位置变了、块数不同，只有剥掉占位符才对得上。
    const providerMessage = {
      role: 'user',
      content: [
        { type: 'text', text: '看 ' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: ' 这个' },
      ],
    };
    const desktopRow = {
      role: 'user',
      content: [
        { type: 'text', text: '看 ' },
        { type: 'text', text: ' 这个' },
        { type: 'text', text: '[图片]' },
      ],
    };
    expect(comparableMessageText(providerMessage)).toBe(comparableText(input));
    expect(comparableMessageText(desktopRow)).toBe(comparableText(input));
  });

  it('matches a plain-text message across the two projections', () => {
    const content = [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ];
    expect(comparableContentText(content)).toBe('helloworld');
    expect(comparableContentText('hello\nworld')).toBe('hello world');
  });

  it('keeps a media-only message empty so callers can report "cannot locate"', () => {
    expect(comparableContentText([{ type: 'image', source: {} }])).toBe('');
    expect(comparableMessageText({ role: 'user', content: '[图片]' })).toBe('');
  });

  it('ignores messages without content', () => {
    expect(comparableMessageText({ role: 'assistant' })).toBe('');
    expect(comparableMessageText(null)).toBe('');
  });
});
