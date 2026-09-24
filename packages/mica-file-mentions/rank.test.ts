import { describe, expect, it } from 'vitest';
import {
  activeFileMention,
  matchWorkspaceFiles,
  mentionPath,
  mentionText,
  normalizePathQuery,
  rankWorkspaceFiles,
  scorePath,
} from './rank.js';

describe('activeFileMention', () => {
  it('triggers for the token after an at sign at the start of a word', () => {
    expect(activeFileMention('@', 1)).toEqual({ start: 0, query: '' });
    expect(activeFileMention('看下 @src/ch', 11)).toEqual({ start: 3, query: 'src/ch' });
    expect(activeFileMention('参考@src/a.ts', 11)).toEqual({ start: 2, query: 'src/a.ts' });
    expect(activeFileMention('[@a.ts]', 6)).toEqual({ start: 1, query: 'a.ts' });
  });

  it('ignores an at sign glued into a word or followed by whitespace', () => {
    expect(activeFileMention('mail@example.com', 16)).toBeNull();
    expect(activeFileMention('看下 @src/ch ', 12)).toBeNull();
    expect(activeFileMention('a@b @c', 6)).toEqual({ start: 4, query: 'c' });
  });

  it('reads the query up to the caret only', () => {
    expect(activeFileMention('@src/a.ts 后面', 9)).toEqual({ start: 0, query: 'src/a.ts' });
    expect(activeFileMention('@src/a.ts 后面', 5)).toEqual({ start: 0, query: 'src/' });
  });
});

describe('mentionPath', () => {
  it('quotes paths that would otherwise be split into two words', () => {
    expect(mentionPath('src/a.ts')).toBe('src/a.ts');
    expect(mentionPath('a b/c.ts')).toBe('"a b/c.ts"');
    expect(mentionText('docs/')).toBe('@docs/ ');
    expect(mentionText('a b/c.ts')).toBe('@"a b/c.ts" ');
  });
});

describe('scorePath', () => {
  it('grades exact, prefix, substring and path matches', () => {
    expect(scorePath('src/doc.ts', 'doc.ts', false)).toEqual({ score: 100, basenameMatch: true });
    expect(scorePath('src/doc.ts', 'doc', false)).toEqual({ score: 80, basenameMatch: true });
    expect(scorePath('src/indoc.ts', 'doc', false)).toEqual({ score: 50, basenameMatch: true });
    expect(scorePath('src/doc/readme.md', 'doc', false)).toEqual({ score: 30, basenameMatch: false });
    expect(scorePath('src/other.ts', 'doc', false)).toEqual({ score: 0, basenameMatch: false });
  });

  it('gives directories a small bonus so they surface ahead of files', () => {
    expect(scorePath('docs', 'doc', true).score).toBe(90);
  });
});

describe('matchWorkspaceFiles', () => {
  it('sorts files by path when the query is empty and never lists directories', () => {
    const items = matchWorkspaceFiles(['src/plain.ts', 'a.ts', 'src/utils/fuzzy.ts'], '');
    expect(items.map((item) => item.path)).toEqual(['a.ts', 'src/plain.ts', 'src/utils/fuzzy.ts']);
  });

  it('describes a git-reported directory entry by name instead of an empty label', () => {
    // `git ls-files --others` 把嵌套仓库报成 `temp/pi/`，basename 是空串
    const items = matchWorkspaceFiles(['temp/pi/', 'a.ts'], '');
    expect(items[1]).toMatchObject({ path: 'temp/pi/', label: 'pi/', description: 'temp/pi' });
  });

  it('truncates the ranked list to the shared limit', () => {
    const files = Array.from({ length: 40 }, (_, index) => `src/doc-${index}.ts`);
    expect(matchWorkspaceFiles(files, 'doc')).toHaveLength(20);
  });

  it('normalizes a leading ./ and backslashes in the query', () => {
    expect(normalizePathQuery(' ./src\\a ')).toBe('src/a');
    const items = matchWorkspaceFiles(['src/a/b.ts'], normalizePathQuery('./src\\a'));
    expect(items.map((item) => item.path)).toContain('src/a/b.ts');
  });
});

describe('rankWorkspaceFiles', () => {
  it('reports directories with a trailing slash and their parent path', () => {
    const ranked = rankWorkspaceFiles(['docs/readme.md'], 'doc');
    expect(ranked[0]).toMatchObject({
      path: 'docs/',
      label: 'docs/',
      description: 'docs',
      isDirectory: true,
    });
  });
});
