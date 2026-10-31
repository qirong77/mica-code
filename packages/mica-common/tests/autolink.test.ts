import { describe, expect, it } from 'vitest';
import { findAutolinks, splitAutolinkPunctuation } from '../autolink.js';

describe('splitAutolinkPunctuation', () => {
  it('cuts the full-width full stop that GFM leaves inside the link', () => {
    expect(splitAutolinkPunctuation('http://10.190.46.109:9200。')).toEqual({
      url: 'http://10.190.46.109:9200',
      text: 'http://10.190.46.109:9200',
      trailing: '。',
    });
  });

  it('cuts a run of full-width punctuation', () => {
    expect(splitAutolinkPunctuation('https://example.com/a），', 'https://example.com/a），')).toEqual({
      url: 'https://example.com/a',
      text: 'https://example.com/a',
      trailing: '），',
    });
  });

  it('cuts the Chinese sentence that marked swallows after the URL', () => {
    expect(splitAutolinkPunctuation('https://example.com/a。然后继续')).toEqual({
      url: 'https://example.com/a',
      text: 'https://example.com/a',
      trailing: '。然后继续',
    });
  });

  it('keeps ASCII trailing punctuation alone for the renderer to handle', () => {
    expect(splitAutolinkPunctuation('https://example.com/a.')).toBeNull();
    expect(splitAutolinkPunctuation('https://example.com/a,')).toBeNull();
  });

  it('leaves an explicit link alone when its text lacks the punctuation', () => {
    expect(splitAutolinkPunctuation('https://example.com/a。', '看这里')).toBeNull();
  });

  it('keeps percent-encoded and plain ASCII URLs untouched', () => {
    const url = 'https://example.com/a%20b?q=1#x';
    expect(splitAutolinkPunctuation(url, url)).toBeNull();
  });

  it('keeps punctuation inside the path when the display text differs', () => {
    expect(splitAutolinkPunctuation('https://example.com/a。b', 'a。b 文档')).toBeNull();
  });

  it('ignores links that are only punctuation', () => {
    expect(splitAutolinkPunctuation('。')).toBeNull();
  });
});

describe('findAutolinks', () => {
  it('finds a bare URL inside a Chinese sentence', () => {
    const [match] = findAutolinks('已部署到 http://155.254.127.215/interview/ 了');
    expect(match).toMatchObject({
      url: 'http://155.254.127.215/interview/',
      text: 'http://155.254.127.215/interview/',
      start: 5,
    });
    expect(match.end - match.start).toBe(match.text.length);
  });

  it('stops at full-width punctuation glued to the URL', () => {
    expect(findAutolinks('访问https://example.com/a，整理面试题')[0]).toMatchObject({
      url: 'https://example.com/a',
      text: 'https://example.com/a',
      start: 2,
    });
  });

  it('adds the scheme for a www host but keeps the written text', () => {
    expect(findAutolinks('看 www.example.com 吧。')[0]).toMatchObject({
      url: 'http://www.example.com',
      text: 'www.example.com',
    });
  });

  it('drops the closing parenthesis that wraps the link', () => {
    expect(findAutolinks('（见 https://example.com/a）')[0].url).toBe('https://example.com/a');
    expect(findAutolinks('(see https://example.com/a)')[0].url).toBe('https://example.com/a');
  });

  it('keeps a balanced parenthesis that belongs to the URL', () => {
    expect(findAutolinks('https://en.wikipedia.org/wiki/Foo_(bar)')[0].url).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    );
  });

  it('does not cut into a word', () => {
    expect(findAutolinks('xhttps://example.com')).toHaveLength(0);
    expect(findAutolinks('和https://example.com/a')).toHaveLength(1);
  });

  it('returns nothing without a candidate', () => {
    expect(findAutolinks('没有链接的一段话')).toEqual([]);
    expect(findAutolinks('')).toEqual([]);
  });
});
