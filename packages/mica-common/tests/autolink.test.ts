import { describe, expect, it } from 'vitest';
import { splitAutolinkPunctuation } from '../autolink.js';

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
