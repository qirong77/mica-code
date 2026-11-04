import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryTool, parseMemoryToolInput } from './MemoryTool.js';
import { MemoryRepository } from './store.js';
import type { MemoryContext, MemoryScope } from './scope.js';
import type { RepoIdentity } from './repo.js';
import type { DomainDefinition } from './domains.js';

const tempDirs: string[] = [];

const repo: RepoIdentity = {
  slug: 'mica-code-abcdef12',
  name: 'mica-code',
  root: '/repo/mica-code',
  key: 'git.example.com/team/mica-code',
  remote: 'git.example.com/team/mica-code',
  source: 'git',
};
const zuche: DomainDefinition = {
  name: '租车',
  path: '/memory/domains/租车.md',
  match: ['/repo/sass'],
  description: null,
};
const other: DomainDefinition = {
  name: 'mica',
  path: '/memory/domains/mica.md',
  match: ['/repo/mica-code'],
  description: null,
};

const PROJECT = { kind: 'project', repo } as const satisfies MemoryScope;

function makeRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `mica-memory-tool-${name}-`));
  tempDirs.push(dir);
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'config'), `[remote "origin"]\n  url = git@git.example.com:team/${name}.git\n`);
  return dir;
}

function context(overrides: Partial<MemoryContext> = {}): MemoryContext {
  return {
    cwd: '/repo/mica-code/apps/desktop',
    repo,
    taskRepos: [],
    repos: [repo],
    project: PROJECT,
    domains: [],
    knownDomains: [],
    ...overrides,
  };
}

function createTool(current: MemoryContext = context()) {
  const dir = mkdtempSync(join(tmpdir(), 'mica-memory-tool-'));
  tempDirs.push(dir);
  const repository = new MemoryRepository({
    rootDir: dir,
    budgets: { profile: 1200, project: 2400, domain: 2400 },
  });
  return { repository, tool: new MemoryTool(repository, () => current) };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseMemoryToolInput', () => {
  it('defaults to the current project, not to a global scope', () => {
    const parsed = parseMemoryToolInput({ operations: [{ action: 'add', content: 'x' }] }, context());

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.scope).toEqual(PROJECT);
  });

  it('refuses to guess a scope when the working directory is not a repository', () => {
    const parsed = parseMemoryToolInput(
      { operations: [{ action: 'add', content: 'x' }] },
      context({ repo: null, project: null }),
    );

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain('`repo`');
      expect(parsed.message).toContain('scope=profile');
      expect(parsed.message).toContain('scope=domain');
    }
  });

  it('writes to an explicitly named repository instead of the session one', () => {
    const sass = makeRepo('sass');
    const parsed = parseMemoryToolInput(
      { repo: sass, operations: [{ action: 'add', content: '灰度配置在 config/gray.json' }] },
      context(),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.scope.kind).toBe('project');
    if (parsed.scope.kind !== 'project') return;
    expect(parsed.scope.repo.name).toBe('sass');
    // 仓库根是 realpath（macOS 上 /var 会解析成 /private/var）
    expect(parsed.scope.repo.root).toBe(realpathSync(sass));
    expect(parsed.scope.note).toBe('本次任务目标');
  });

  it('accepts a path inside the target repository that does not exist yet', () => {
    const sass = makeRepo('sass');
    const parsed = parseMemoryToolInput({ repo: join(sass, 'src/not-yet.ts') }, context());
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.scope.kind === 'project') expect(parsed.scope.repo.name).toBe('sass');
  });

  it('rejects a repo path that is not inside any repository', () => {
    const bare = mkdtempSync(join(tmpdir(), 'mica-memory-bare-'));
    tempDirs.push(bare);
    const parsed = parseMemoryToolInput({ repo: bare }, context());
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain('not inside a recognizable repository');
  });

  it('requires a name for domain and lists the available ones', () => {
    const current = context({ domains: [other], knownDomains: [other, zuche] });

    const missing = parseMemoryToolInput({ scope: 'domain' }, current);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain('租车');

    const unknown = parseMemoryToolInput({ scope: 'domain', domain: '不存在' }, current);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.message).toContain('unknown domain');
  });

  it('refuses a domain that does not cover the current directory', () => {
    // 写进去下次也注入不到这里——那正是「记忆错位」的来源。
    const current = context({ domains: [], knownDomains: [zuche] });

    const parsed = parseMemoryToolInput({ scope: 'domain', domain: '租车', operations: [] }, current);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain('does not cover the current working directory');
      expect(parsed.message).toContain('scope=project');
    }
  });

  it('accepts a domain that covers the current directory', () => {
    const current = context({ domains: [zuche], knownDomains: [zuche] });

    const parsed = parseMemoryToolInput({ scope: 'domain', domain: '租车' }, current);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.scope.kind).toBe('domain');
  });

  it('allows profile anywhere', () => {
    const parsed = parseMemoryToolInput(
      { scope: 'profile', operations: [{ action: 'add', content: '用户偏好中文' }] },
      context({ repo: null, project: null }),
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.scope).toEqual({ kind: 'profile' });
  });

  it('rejects unknown fields and invalid scopes', () => {
    expect(parseMemoryToolInput({ target: 'user' }, context()).ok).toBe(false);
    expect(parseMemoryToolInput({ scope: 'memory' }, context()).ok).toBe(false);
    expect(parseMemoryToolInput({ operations: [{ action: 'add', content: 'x', extra: 1 }] }, context()).ok).toBe(false);
  });

  it('requires content for add and old_text for patch / remove', () => {
    const current = context();
    expect(parseMemoryToolInput({ operations: [{ action: 'add' }] }, current).ok).toBe(false);
    expect(parseMemoryToolInput({ operations: [{ action: 'patch', content: 'x' }] }, current).ok).toBe(false);
    expect(parseMemoryToolInput({ operations: [{ action: 'remove', old_text: '  ' }] }, current).ok).toBe(false);
  });

  it('carries the pin flag', () => {
    const parsed = parseMemoryToolInput(
      { operations: [{ action: 'add', content: '回答用中文', pin: true }] },
      context(),
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.operations).toEqual([{ action: 'add', content: '回答用中文', pin: true }]);
  });

  it('rejects more operations than one call may carry', () => {
    const operations = Array.from({ length: 11 }, () => ({ action: 'add', content: 'x' }));
    expect(parseMemoryToolInput({ operations }, context()).ok).toBe(false);
  });
});

describe('MemoryTool', () => {
  it('reads the store of the current project', async () => {
    const { repository, tool } = createTool();
    repository.apply(PROJECT, [{ action: 'add', content: '项目用 bun' }]);

    const output = await tool.execute({});

    expect(output).toContain('项目记忆 · mica-code · 1 entries');
    expect(output).toContain('1. 项目用 bun');
  });

  it('writes an entry and explains when it becomes visible', async () => {
    const { repository, tool } = createTool();

    const output = await tool.execute({
      scope: 'profile',
      operations: [{ action: 'add', content: '用户偏好中文回复' }],
    });

    expect(output).toContain('Memory updated (用户档案)');
    expect(output).toContain('/memory refresh');
    expect(repository.read({ kind: 'profile' })).toEqual(['用户偏好中文回复']);
  });

  it('warns when the scope is over its injection budget but still writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mica-memory-tool-'));
    tempDirs.push(dir);
    const repository = new MemoryRepository({ rootDir: dir, budgets: { profile: 10, project: 2400, domain: 2400 } });
    const tool = new MemoryTool(repository, () => context());

    const output = await tool.execute({
      scope: 'profile',
      operations: [{ action: 'add', content: 'x'.repeat(50) }],
    });

    expect(output).toContain('over its injection budget');
    expect(repository.read({ kind: 'profile' })).toHaveLength(1);
  });

  it('lists candidates when old_text does not match', async () => {
    const { repository, tool } = createTool();
    repository.apply(PROJECT, [{ action: 'add', content: '已有的一条' }]);

    await expect(tool.execute({ operations: [{ action: 'remove', old_text: '不存在' }] })).rejects.toThrow(
      /Candidates:[\s\S]*已有的一条/,
    );
  });

  it('refuses to run once the plugin is disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mica-memory-tool-'));
    tempDirs.push(dir);
    const repository = new MemoryRepository({ rootDir: dir });
    const tool = new MemoryTool(
      repository,
      () => context(),
      () => false,
    );

    await expect(tool.execute({})).rejects.toThrow(/disabled/i);
  });

  it('describes the call including the scope', () => {
    const { tool } = createTool();

    expect(tool.onToolUseDisplayText({})).toBe('Reviewing memory (project)');
    expect(
      tool.onToolUseDisplayText({
        scope: 'domain',
        domain: '租车',
        operations: [{ action: 'add' }, { action: 'patch' }],
      }),
    ).toBe('Saving memory (domain:租车, add, patch)');
  });

  it('states the scope rules in the tool description', () => {
    const { tool } = createTool();
    const description = tool.description;

    expect(description).toContain('project');
    expect(description).toContain('domain');
    expect(description).toContain('profile');
    expect(description).toContain('Rules');
    expect(description).toContain('empty call is a correct outcome');
  });
});
