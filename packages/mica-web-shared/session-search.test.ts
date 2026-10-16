import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_SEARCH_RANGE,
  SEARCH_TIERS,
  extractSnippet,
  foldSearchText,
  matchAllTokens,
  matchRanges,
  scoreSessionSearch,
  sessionSearchRange,
  sessionSearchSinceMs,
  tokenizeSearchQuery,
} from './session-search.js';

describe('foldSearchText', () => {
  it('lowercases and keeps the original length so snippet offsets stay valid', () => {
    const text = 'Fix The CHATVIEW bug';
    const folded = foldSearchText(text);
    expect(folded).toBe('fix the chatview bug');
    expect(folded.length).toBe(text.length);
  });

  it('folds fullwidth characters and ideographic spaces without changing length', () => {
    const text = 'ＭＩＣＡ\u3000搜索';
    const folded = foldSearchText(text);
    expect(folded).toBe('mica 搜索');
    expect(folded.length).toBe(text.length);
  });

  it('leaves Chinese text untouched', () => {
    expect(foldSearchText('修复会话搜索')).toBe('修复会话搜索');
  });

  it('tolerates non-strings', () => {
    expect(foldSearchText(null)).toBe('');
    expect(foldSearchText(undefined)).toBe('');
    expect(foldSearchText(42)).toBe('42');
  });
});

describe('tokenizeSearchQuery', () => {
  it('splits on whitespace, drops duplicates and folds case', () => {
    expect(tokenizeSearchQuery('  Mica   mica 搜索 ')).toEqual(['mica', '搜索']);
  });

  it('returns nothing for an empty query', () => {
    expect(tokenizeSearchQuery('   ')).toEqual([]);
    expect(tokenizeSearchQuery(null)).toEqual([]);
  });
});

describe('matchAllTokens / matchRanges', () => {
  it('requires every token to be present', () => {
    const folded = foldSearchText('修复 ChatView 的搜索框');
    expect(matchAllTokens(folded, tokenizeSearchQuery('chatview 搜索'))).toBe(true);
    expect(matchAllTokens(folded, tokenizeSearchQuery('chatview 终端'))).toBe(false);
  });

  it('merges overlapping and adjacent ranges', () => {
    const text = 'abcdef';
    expect(matchRanges(text, ['ab', 'bc'])).toEqual([[0, 3]]);
    // 相邻区间也合并：高亮连成一片比分两段更自然。
    expect(matchRanges(text, ['ab', 'cd'])).toEqual([[0, 4]]);
    expect(matchRanges(text, ['ab', 'ef'])).toEqual([
      [0, 2],
      [4, 6],
    ]);
  });

  it('finds every occurrence of a token, not just the first', () => {
    expect(matchRanges('ab ab ab', ['ab'])).toEqual([
      [0, 2],
      [3, 5],
      [6, 8],
    ]);
  });
});

describe('extractSnippet', () => {
  it('slices the original text (not the folded one) and keeps ranges usable', () => {
    const text = `前言\n${'x'.repeat(80)}\nMica 的搜索太难用了，需要内容搜索\n结尾`;
    const snippet = extractSnippet(text, tokenizeSearchQuery('mica 内容'), 10);
    expect(snippet).not.toBeNull();
    const { text: body, ranges } = snippet!;
    expect(body.startsWith('…')).toBe(true);
    expect(body).toContain('Mica 的搜索太难用了');
    // 区间相对返回的片段（含省略号），且必须落在原始大小写的文字上。
    for (const [start, end] of ranges) {
      const hit = body.slice(start, end);
      expect(foldSearchText(hit)).toBe('mica');
    }
  });

  it('collapses line breaks into spaces without breaking offsets', () => {
    const text = '第一行\n第二行 Mica\n第三行';
    const snippet = extractSnippet(text, ['mica'], 3)!;
    expect(snippet.text).not.toContain('\n');
    expect(snippet.text.slice(...snippet.ranges[0]!)).toBe('Mica');
  });

  it('returns null when nothing matches or the input is empty', () => {
    expect(extractSnippet('abc', ['zzz'])).toBeNull();
    expect(extractSnippet('', ['a'])).toBeNull();
    expect(extractSnippet('abc', [])).toBeNull();
  });
});

describe('scoreSessionSearch', () => {
  const tokens = tokenizeSearchQuery('mica 搜索');

  it('ranks a title hit above a cwd hit and a cwd hit above content', () => {
    const title = scoreSessionSearch({ title: 'mica 搜索优化', hasContent: true }, tokens);
    const cwd = scoreSessionSearch({ cwd: '/work/mica-搜索', hasContent: true }, tokens);
    const content = scoreSessionSearch({ hasContent: true }, tokens);
    expect(title).toBeGreaterThan(cwd);
    expect(cwd).toBeGreaterThan(content);
  });

  it('ranks a prefix hit above a mid-title hit', () => {
    const prefix = scoreSessionSearch({ title: 'mica 搜索' }, tokens);
    const contains = scoreSessionSearch({ title: '关于 mica 搜索' }, tokens);
    expect(prefix).toBeGreaterThan(contains);
  });

  it('ranks a session where every token hits the title above one that leans on content', () => {
    const allInTitle = scoreSessionSearch({ title: 'mica 搜索', hasContent: true }, tokens);
    const split = scoreSessionSearch({ title: 'mica 优化', hasContent: true }, tokens);
    expect(allInTitle).toBeGreaterThan(split);
  });

  it('fails the whole session when any token is missing', () => {
    expect(scoreSessionSearch({ title: 'mica' }, tokens)).toBe(-1);
    expect(scoreSessionSearch({}, [])).toBe(-1);
  });

  it('counts extras (group name, loop task) as a weak local hit', () => {
    const extras = scoreSessionSearch({ extras: ['mica 搜索相关的会话'], hasContent: true }, tokens);
    expect(extras).toBeGreaterThan(0);
    expect(extras).toBeLessThan(scoreSessionSearch({ cwd: '/work/mica-搜索' }, tokens));
  });

  it('matches the cwd basename even when the token never appears as a path word', () => {
    const byName = scoreSessionSearch({ cwd: '/Users/me/mica-code' }, ['mica-code']);
    expect(byName).toBe(SEARCH_TIERS.cwdName * 100 + SEARCH_TIERS.cwdName);
  });

  it('ignores a trailing slash when reading the basename', () => {
    expect(scoreSessionSearch({ cwd: '/Users/me/mica-code/' }, ['mica-code'])).toBe(
      SEARCH_TIERS.cwdName * 100 + SEARCH_TIERS.cwdName,
    );
  });
});

describe('sessionSearchSinceMs', () => {
  const noon = new Date(2026, 0, 10, 12, 0, 0).getTime();

  it('starts at local midnight for a one-day range', () => {
    expect(sessionSearchSinceMs('1d', noon)).toBe(new Date(2026, 0, 10).getTime());
  });

  it('includes today in a multi-day range', () => {
    expect(sessionSearchSinceMs('3d', noon)).toBe(new Date(2026, 0, 8).getTime());
    expect(sessionSearchSinceMs('7d', noon)).toBe(new Date(2026, 0, 4).getTime());
  });

  it('treats "all" and unknown ids as unrestricted', () => {
    expect(sessionSearchSinceMs('all', noon)).toBe(0);
    expect(sessionSearchSinceMs(DEFAULT_SESSION_SEARCH_RANGE, noon)).toBeGreaterThan(0);
  });

  it('falls back to the default range for unknown ids', () => {
    expect(sessionSearchRange('nonsense').id).toBe(DEFAULT_SESSION_SEARCH_RANGE);
  });
});
