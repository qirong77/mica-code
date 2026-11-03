import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  domainBody,
  ensureDomain,
  formatDomainFrontmatter,
  listDomains,
  matchDomains,
  matchesPath,
  parseFrontmatter,
} from './domains.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mica-memory-domains-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('matchesPath', () => {
  it('treats a declared directory as covering everything below it', () => {
    expect(matchesPath('/repo/sass', '/repo/sass')).toBe(true);
    expect(matchesPath('/repo/sass', '/repo/sass/src/views/a.vue')).toBe(true);
  });

  it('does not match a sibling with a shared prefix', () => {
    // 旧设计按字符串前缀比较过：`/repo/sass` 会命中 `/repo/sass-old`。
    expect(matchesPath('/repo/sass', '/repo/sass-old/src')).toBe(false);
  });

  it('supports wildcards per path segment', () => {
    expect(matchesPath('/repo/zuche-*', '/repo/zuche-release/apps')).toBe(true);
    expect(matchesPath('/repo/zuche-*', '/repo/mis')).toBe(false);
    expect(matchesPath('/repo/*/src', '/repo/sass/src')).toBe(true);
    expect(matchesPath('/repo/*/src', '/repo/sass/test')).toBe(false);
  });

  it('expands a leading tilde', () => {
    expect(matchesPath('~/Desktop/project', join(homedir(), 'Desktop', 'project'))).toBe(true);
  });

  it('asks for more path than the pattern has', () => {
    expect(matchesPath('/repo/a/b', '/repo/a')).toBe(false);
  });
});

describe('parseFrontmatter', () => {
  it('reads a block list and a description', () => {
    const meta = parseFrontmatter(
      ['---', 'description: 租车相关', 'match:', '  - /repo/sass', '  - /repo/mis', '---', '', '正文'].join('\n'),
    );

    expect(meta.match).toEqual(['/repo/sass', '/repo/mis']);
    expect(meta.description).toBe('租车相关');
  });

  it('reads an inline list', () => {
    expect(parseFrontmatter('---\nmatch: [/repo/a, /repo/b]\n---\n').match).toEqual(['/repo/a', '/repo/b']);
  });

  it('returns nothing for a file without frontmatter', () => {
    expect(parseFrontmatter('一条记忆\n\n另一条')).toEqual({ match: [], description: null });
  });
});

describe('listDomains', () => {
  it('reads every domain file', () => {
    const root = tempDir();
    ensureDomain(root, '租车', ['/repo/sass']);
    ensureDomain(root, 'mica', ['/repo/mica-code']);

    const domains = listDomains(root).map((domain) => domain.name);
    expect(domains).toEqual(['mica', '租车']);
  });

  it('returns an empty list when no domain is defined', () => {
    expect(listDomains(tempDir())).toEqual([]);
  });
});

describe('ensureDomain', () => {
  it('creates a domain with its match block', () => {
    const root = tempDir();
    const result = ensureDomain(root, '租车', ['/repo/sass', '/repo/mis']);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    const text = readFileSync(result.path, 'utf-8');
    expect(text).toContain('match:');
    expect(text).toContain('  - /repo/sass');
    expect(parseFrontmatter(text).match).toEqual(['/repo/sass', '/repo/mis']);
  });

  it('appends new paths without dropping existing ones or the body', () => {
    const root = tempDir();
    const created = ensureDomain(root, '租车', ['/repo/sass']);
    if (!created.ok) throw new Error('setup failed');
    writeFileSync(created.path, `${readFileSync(created.path, 'utf-8')}已有的一条\n`, 'utf-8');

    const updated = ensureDomain(root, '租车', ['/repo/mis', '/repo/sass']);

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.created).toBe(false);
    const text = readFileSync(updated.path, 'utf-8');
    expect(parseFrontmatter(text).match).toEqual(['/repo/sass', '/repo/mis']);
    expect(domainBody(text)).toContain('已有的一条');
  });

  it('rejects names that would escape the domains directory', () => {
    const root = tempDir();
    expect(ensureDomain(root, '../evil', ['/repo']).ok).toBe(false);
    expect(ensureDomain(root, 'a/b', ['/repo']).ok).toBe(false);
    expect(ensureDomain(root, '', ['/repo']).ok).toBe(false);
  });

  it('refuses to create a domain without any path', () => {
    expect(ensureDomain(tempDir(), '租车', []).ok).toBe(false);
  });
});

describe('matchDomains', () => {
  it('matches by working directory and by repository root', () => {
    const root = tempDir();
    ensureDomain(root, '租车', ['/repo/zuche-*']);
    const domains = listDomains(root);

    expect(matchDomains(domains, ['/repo/zuche-release/apps'])).toHaveLength(1);
    // 仓库根不在领域里、但 cwd 在，仍然算命中。
    expect(matchDomains(domains, ['/repo/mica-code/apps', '/repo/zuche-release'])).toHaveLength(1);
  });

  it('returns nothing when no declared path covers the session', () => {
    const root = tempDir();
    ensureDomain(root, '租车', ['/repo/sass']);
    expect(matchDomains(listDomains(root), ['/repo/mica-code'])).toEqual([]);
  });

  it('can match more than one domain', () => {
    const root = tempDir();
    ensureDomain(root, '租车', ['/repo/sass']);
    ensureDomain(root, '发布', ['/repo/sass']);

    expect(
      matchDomains(listDomains(root), ['/repo/sass'])
        .map((domain) => domain.name)
        .sort(),
    ).toEqual(['发布', '租车']);
  });

  it('uses a realpath match for symlinked parents', () => {
    const real = tempDir();
    const link = join(tempDir(), 'link');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link, 'dir');
    const root = tempDir();
    ensureDomain(root, '租车', [real]);

    expect(matchDomains(listDomains(root), [link])).toHaveLength(1);
  });
});

describe('formatDomainFrontmatter', () => {
  it('round-trips through the parser', () => {
    const text = formatDomainFrontmatter({ name: '租车', match: ['/repo/sass'], description: '租车相关' });
    expect(parseFrontmatter(text)).toEqual({ match: ['/repo/sass'], description: '租车相关' });
  });
});
