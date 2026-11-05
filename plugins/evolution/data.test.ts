import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configModelDiscovery } from './data/config.js';
import { memoryScopes } from './data/memory.js';
import { sessionTagSlots } from './data/session-tags.js';

const dirs: string[] = [];

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mica-evolution-data-'));
  dirs.push(dir);
  return dir;
}

function run(migration: { run(context: { home: string; log: () => void }): number }, root: string): number {
  return migration.run({ home: root, log: () => {} });
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

function entries(path: string): string[] {
  return readFileSync(path, 'utf-8')
    .split(/\n{2,}/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('memory 旧布局迁移', () => {
  it('把 USER.md / MEMORY.md 并进 PROFILE.md，把项目目录并进同名项目文件', () => {
    const root = home();
    write(join(root, 'memory', 'USER.md'), '用户画像 A\n');
    write(join(root, 'memory', 'MEMORY.md'), '全局笔记 B\n');
    write(join(root, 'memory', 'PROFILE.md'), '已有条目 C\n\n用户画像 A\n');
    write(join(root, 'memory', 'projects', 'mica-code-12de4a5d', 'MEMORY.md'), '项目条目 D\n');
    // 记忆的跨进程锁在文件旁边留一个空目录：内容搬走之后它不该继续占着旧目录。
    mkdirSync(join(root, 'memory', 'projects', 'mica-code-12de4a5d', 'MEMORY.md.lock.owners'), {
      recursive: true,
    });
    write(join(root, 'memory', 'projects', 'mica-code-2d7741c9.md'), '项目条目 E\n');

    expect(run(memoryScopes, root)).toBe(2);

    const profile = entries(join(root, 'memory', 'PROFILE.md'));
    expect(profile).toEqual(['已有条目 C', '用户画像 A', '全局笔记 B']);
    const project = entries(join(root, 'memory', 'projects', 'mica-code-2d7741c9.md'));
    expect(project).toEqual(['项目条目 E', '项目条目 D']);
    expect(existsSync(join(root, 'memory', 'USER.md'))).toBe(false);
    expect(existsSync(join(root, 'memory', 'MEMORY.md'))).toBe(false);
    expect(existsSync(join(root, 'memory', 'projects', 'mica-code-12de4a5d'))).toBe(false);

    // 幂等：第二次没有可改的东西。
    expect(run(memoryScopes, root)).toBe(0);
  });

  it('只剩锁目录的旧项目目录也一并收掉（内容早先被清过）', () => {
    const root = home();
    mkdirSync(join(root, 'memory', 'projects', 'gone-repo-abcdef12', 'MEMORY.md.lock.owners'), {
      recursive: true,
    });
    expect(run(memoryScopes, root)).toBe(0);
    expect(existsSync(join(root, 'memory', 'projects', 'gone-repo-abcdef12'))).toBe(false);
  });

  it('没有同名项目文件的旧目录原样留着，不算改动', () => {
    const root = home();
    const legacy = join(root, 'memory', 'projects', 'gone-repo-abcdef12', 'MEMORY.md');
    write(legacy, '没人认领的条目\n');

    expect(run(memoryScopes, root)).toBe(0);
    expect(existsSync(legacy)).toBe(true);
  });

  it('同名项目文件有两个时不猜，旧目录不动', () => {
    const root = home();
    write(join(root, 'memory', 'projects', 'dup-11111111', 'MEMORY.md'), '旧条目\n');
    write(join(root, 'memory', 'projects', 'dup-22222222.md'), 'A\n');
    write(join(root, 'memory', 'projects', 'dup-33333333.md'), 'B\n');

    expect(run(memoryScopes, root)).toBe(0);
    expect(existsSync(join(root, 'memory', 'projects', 'dup-11111111', 'MEMORY.md'))).toBe(true);
    expect(entries(join(root, 'memory', 'projects', 'dup-22222222.md'))).toEqual(['A']);
  });

  it('没有旧布局时什么都不做', () => {
    const root = home();
    write(join(root, 'memory', 'PROFILE.md'), '只有新布局\n');
    expect(run(memoryScopes, root)).toBe(0);
  });
});

describe('会话标签旧色槽迁移', () => {
  const file = (root: string) => join(root, 'plugin-data', 'session-tags', 'session-annotations.json');

  it('清掉没用过的旧色槽，保留挂着会话的那个与用户改过名的', () => {
    const root = home();
    write(
      file(root),
      JSON.stringify({
        version: 1,
        name: 'Session Tags',
        options: [
          { id: 'red', label: 'Red', color: '#FF3B30' },
          { id: 'blue', label: 'Blue', color: '#007AFF' },
          { id: 'gray', label: '待排查', color: '#8E8E93' },
          { id: 'tag-2', label: '需求', color: '#FF9500' },
        ],
        assignments: { s1: ['blue'], s2: ['tag-2', 'blue', 'gone'] },
      }),
    );

    expect(run(sessionTagSlots, root)).toBe(1);
    const store = JSON.parse(readFileSync(file(root), 'utf-8'));
    expect(store.options.map((option: { id: string }) => option.id)).toEqual(['blue', 'gray', 'tag-2']);
    expect(store.assignments).toEqual({ s1: ['blue'], s2: ['blue', 'tag-2'] });
    expect(run(sessionTagSlots, root)).toBe(0);
  });

  it('只剩没用过的旧色槽时落一个「待 review」，删空的表不会长回来', () => {
    const root = home();
    write(
      file(root),
      JSON.stringify({
        version: 1,
        name: 'Session Tags',
        options: [
          { id: 'red', label: 'Red', color: '#FF3B30' },
          { id: 'gray', label: 'Gray', color: '#8E8E93' },
        ],
        assignments: {},
      }),
    );
    expect(run(sessionTagSlots, root)).toBe(1);
    expect(JSON.parse(readFileSync(file(root), 'utf-8')).options).toEqual([
      { id: 'tag-1', label: '待 review', color: '#FF9500' },
    ]);

    write(file(root), JSON.stringify({ version: 1, name: 'Session Tags', options: [], assignments: {} }));
    expect(run(sessionTagSlots, root)).toBe(0);
    expect(JSON.parse(readFileSync(file(root), 'utf-8')).options).toEqual([]);
  });

  it('坏文件不覆盖', () => {
    const root = home();
    write(file(root), '{ not json');
    expect(run(sessionTagSlots, root)).toBe(0);
    expect(readFileSync(file(root), 'utf-8')).toBe('{ not json');
  });
});

describe('config 旧模型发现字段迁移', () => {
  it('删掉 get_model_url 与空的默认模型，保留手填的模型清单', () => {
    const root = home();
    write(
      join(root, 'config.json'),
      JSON.stringify({
        providers: [
          {
            id: 'deepseek',
            api_base: 'https://api.deepseek.com',
            protocol: 'openai_chat_completions',
            get_model_url: 'https://api.deepseek.com/models',
            models: ['deepseek-chat'],
          },
        ],
        defaultModel: { provider: 'deepseek', model: '' },
      }),
    );

    expect(run(configModelDiscovery, root)).toBe(2);
    const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf-8'));
    expect(config.providers[0]).toEqual({
      id: 'deepseek',
      api_base: 'https://api.deepseek.com',
      protocol: 'openai_chat_completions',
      models: ['deepseek-chat'],
    });
    expect('defaultModel' in config).toBe(false);
    expect(run(configModelDiscovery, root)).toBe(0);
  });

  it('有内容的默认模型不动', () => {
    const root = home();
    const original = {
      providers: [{ id: 'p', api_base: 'https://example.com', protocol: 'openai_responses' }],
      defaultModel: { provider: 'p', model: 'm', effort: 'high' },
    };
    write(join(root, 'config.json'), JSON.stringify(original));
    expect(run(configModelDiscovery, root)).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf-8'))).toEqual(original);
  });

  it('没有 config.json 时什么都不做', () => {
    const root = home();
    expect(run(configModelDiscovery, root)).toBe(0);
    expect(readdirSync(root)).toEqual([]);
  });
});
