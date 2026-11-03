import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

/**
 * 领域：跨仓库、但只在一个主题内成立的知识。
 *
 * 真实形态是「一组同域仓库」——租车后端 `mis`、PC 端 `sass`、小程序
 * `zuche-staff-service`、发布台 `zuche-release` 之间共享的坑远多于它们各自的约定，
 * 但这些事实放进全局记忆就会污染所有无关会话（改 mica 桌面端时被灌一屏 sass cookie）。
 *
 * 领域由**目录**声明，不由模型猜：文件头部的 `match` 列出这个领域覆盖哪些路径，
 * 会话的 cwd / 仓库根落在其中才注入。判定只读文件，不跑命令。
 */

export type DomainDefinition = {
  /** 领域名，同时也是 `<name>.md` 的文件名。 */
  name: string;
  path: string;
  match: string[];
  description: string | null;
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function listDomains(memoryRoot: string): DomainDefinition[] {
  const dir = domainsDir(memoryRoot);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.md'));
  } catch {
    return [];
  }
  const domains: DomainDefinition[] = [];
  for (const file of names.sort()) {
    const path = join(dir, file);
    let text: string;
    try {
      text = readFileSync(path, 'utf-8');
    } catch {
      continue;
    }
    const meta = parseFrontmatter(text);
    domains.push({
      name: basename(file, '.md'),
      path,
      match: meta.match,
      description: meta.description,
    });
  }
  return domains;
}

export function domainsDir(memoryRoot: string): string {
  return join(memoryRoot, 'domains');
}

/**
 * 新建/扩展一个领域。领域是用户显式划定的知识边界，所以只有命令能建——
 * 模型不能凭空造一个「领域」把记忆塞进去，那等于换了个名字的全局记忆。
 */
export function ensureDomain(
  memoryRoot: string,
  name: string,
  paths: string[],
  description?: string | null,
): { ok: true; path: string; created: boolean } | { ok: false; error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: '领域名不能为空' };
  if (/[/\\:*?"<>|]/.test(trimmed) || trimmed.startsWith('.')) {
    return { ok: false, error: `领域名不能包含路径分隔符或以 . 开头：${trimmed}` };
  }
  const dir = domainsDir(memoryRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${trimmed}.md`);
  const additions = paths.map((item) => item.trim()).filter(Boolean);
  if (additions.length === 0) return { ok: false, error: '至少要给一个覆盖路径' };

  if (!existsSync(path)) {
    writeFileSync(path, `${formatDomainFrontmatter({ name: trimmed, match: additions, description })}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    return { ok: true, path, created: true };
  }

  const text = readFileSync(path, 'utf-8');
  const meta = parseFrontmatter(text);
  const merged = [...meta.match];
  let changed = false;
  for (const addition of additions) {
    if (!merged.includes(addition)) {
      merged.push(addition);
      changed = true;
    }
  }
  if (!changed) return { ok: true, path, created: false };
  const body = domainBody(text);
  writeFileSync(
    path,
    `${formatDomainFrontmatter({ name: trimmed, match: merged, description: meta.description })}\n${body}`,
    { encoding: 'utf-8', mode: 0o600 },
  );
  return { ok: true, path, created: false };
}

/**
 * 哪些领域覆盖了这些路径。
 *
 * 候选路径给的是「会话的 cwd、它的仓库根」——两者都算，因为用户可能从仓库里的
 * 子目录开会话，也可能从 worktree 里开。
 */
export function matchDomains(
  domains: DomainDefinition[],
  candidates: (string | null | undefined)[],
): DomainDefinition[] {
  const paths = candidates
    .map((value) => (typeof value === 'string' ? realpathOrSelf(resolve(value)) : null))
    .filter((value): value is string => Boolean(value));
  if (paths.length === 0) return [];
  const matched: DomainDefinition[] = [];
  for (const domain of domains) {
    // 声明的路径本身也过一遍 realpath：macOS 上 `/var` 指向 `/private/var`，
    // 不归一化会让「明明在目录里却匹配不上」。含通配符的路径保持原样（realpath 会失败）。
    const patterns = domain.match.map((pattern) => realpathOrSelf(expandHome(pattern)));
    if (patterns.some((pattern) => paths.some((path) => matchesPath(pattern, path)))) {
      matched.push(domain);
    }
  }
  return matched;
}

export function parseFrontmatter(text: string): { match: string[]; description: string | null } {
  const block = FRONTMATTER.exec(text);
  if (!block) return { match: [], description: null };
  const match: string[] = [];
  let description: string | null = null;
  let collecting = false;
  for (const rawLine of block[1]!.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const inlineList = /^match\s*:\s*\[(.*)\]$/.exec(line);
    if (inlineList) {
      match.push(
        ...inlineList[1]!
          .split(',')
          .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean),
      );
      collecting = false;
      continue;
    }
    const key = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (key) {
      const name = key[1]!.toLowerCase();
      const value = key[2]!.trim();
      collecting = name === 'match';
      if (name === 'description' && value) description = stripQuotes(value);
      if (name === 'match' && value) match.push(stripQuotes(value));
      continue;
    }
    if (collecting) {
      const item = /^-\s*(.+)$/.exec(line);
      if (item) match.push(stripQuotes(item[1]!.trim()));
    }
  }
  return { match: match.map(expandHome).filter(Boolean), description };
}

export function formatDomainFrontmatter(domain: {
  name: string;
  match: string[];
  description?: string | null;
}): string {
  const lines = ['---'];
  if (domain.description) lines.push(`description: ${domain.description}`);
  lines.push('match:');
  for (const path of domain.match) lines.push(`  - ${path}`);
  lines.push('---', '');
  return lines.join('\n');
}

/** 正文部分（去掉 frontmatter），写进提示词与工具结果时用。 */
export function domainBody(text: string): string {
  return text.replace(FRONTMATTER, '');
}

/**
 * 路径前缀匹配，`*` / `?` 按路径分段通配。
 *
 * 用前缀语义而不是完整 glob：`match` 声明的是「这个领域覆盖哪些目录」，
 * 目录下面任何深度的路径都算命中，否则 `sass/src/views/x.vue` 又要写一条。
 */
export function matchesPath(pattern: string, candidate: string): boolean {
  const expanded = expandHome(pattern);
  if (!expanded) return false;
  const patternParts = normalizeForCompare(expanded).split('/').filter(Boolean);
  const candidateParts = normalizeForCompare(candidate).split('/').filter(Boolean);
  if (patternParts.length === 0 || patternParts.length > candidateParts.length) return false;
  for (let index = 0; index < patternParts.length; index += 1) {
    if (!matchSegment(patternParts[index]!, candidateParts[index]!)) return false;
  }
  return true;
}

function matchSegment(pattern: string, value: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) return pattern === value;
  const source = pattern
    .split('')
    .map((char) => {
      if (char === '*') return '[^/]*';
      if (char === '?') return '[^/]';
      return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${source}$`, 'i').test(value);
}

function normalizeForCompare(path: string): string {
  // Windows 盘符与大小写差异不影响 mac/linux，这里只做分隔符与尾斜杠收敛。
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function expandHome(path: string): string {
  const trimmed = path.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed) return '';
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '').trim();
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
