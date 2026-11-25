import { describe, expect, it } from 'vitest';
import { compactUrl, filterRecent, isRecentUrl, moveHighlight } from './browser-recents.js';

const entries = [
  { url: 'https://github.com/mica/code', title: 'Mica Code' },
  { url: 'https://example.com/docs/start', title: '快速开始' },
  { url: 'https://news.ycombinator.com/', title: '' },
];

describe('isRecentUrl', () => {
  it('only accepts http(s)', () => {
    expect(isRecentUrl('https://a.test/')).toBe(true);
    expect(isRecentUrl('HTTP://a.test/')).toBe(true);
    expect(isRecentUrl('about:blank')).toBe(false);
    expect(isRecentUrl('file:///tmp/x')).toBe(false);
    expect(isRecentUrl('')).toBe(false);
    expect(isRecentUrl(null)).toBe(false);
  });

  it('rejects absurdly long addresses', () => {
    expect(isRecentUrl(`https://a.test/${'x'.repeat(5000)}`)).toBe(false);
  });
});

describe('filterRecent', () => {
  it('returns everything for an empty query', () => {
    expect(filterRecent(entries, '')).toEqual(entries);
    expect(filterRecent(entries, '   ')).toEqual(entries);
  });

  it('matches url or title, case-insensitively', () => {
    expect(filterRecent(entries, 'GITHUB')).toEqual([entries[0]]);
    expect(filterRecent(entries, '开始')).toEqual([entries[1]]);
    expect(filterRecent(entries, 'example.com/docs')).toEqual([entries[1]]);
  });

  it('returns an empty list when nothing matches, and tolerates junk', () => {
    expect(filterRecent(entries, 'nothing-here')).toEqual([]);
    expect(filterRecent(null, 'x')).toEqual([]);
  });
});

describe('moveHighlight', () => {
  it('starts at the first row going down and the last going up', () => {
    expect(moveHighlight(-1, 3, 1)).toBe(0);
    expect(moveHighlight(-1, 3, -1)).toBe(2);
  });

  it('stops at both ends', () => {
    expect(moveHighlight(2, 3, 1)).toBe(2);
    expect(moveHighlight(0, 3, -1)).toBe(0);
  });

  it('collapses to -1 without a list and repairs an out-of-range index', () => {
    expect(moveHighlight(0, 0, 1)).toBe(-1);
    expect(moveHighlight(5, 3, 0)).toBe(-1);
    expect(moveHighlight(1, 3, 0)).toBe(1);
  });
});

describe('compactUrl', () => {
  it('drops the scheme and a trailing root slash', () => {
    expect(compactUrl('https://example.com/')).toBe('example.com');
    expect(compactUrl('https://example.com/docs/start?q=1#top')).toBe(
      'example.com/docs/start?q=1#top',
    );
  });

  it('keeps unparsable input as-is', () => {
    expect(compactUrl('not a url')).toBe('not a url');
    expect(compactUrl('')).toBe('');
  });
});
