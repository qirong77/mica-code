import { describe, expect, it } from 'vitest';
import { MemorySnapshotCache, formatMemorySection, formatMemoryStatus, type MemorySnapshotLoader } from './section.js';
import type { MemoryStoreSnapshot, MemoryTarget } from './store.js';

function snapshot(overrides: Partial<MemoryStoreSnapshot> = {}): MemoryStoreSnapshot {
  return {
    target: 'memory',
    path: '/home/.mica/memory/MEMORY.md',
    label: 'memory/MEMORY.md',
    entries: ['项目用 bun 跑测试'],
    chars: 8,
    limit: 2200,
    projectDir: null,
    ...overrides,
  };
}

function loaderFor(load: (target: MemoryTarget) => MemoryStoreSnapshot): MemorySnapshotLoader {
  return {
    loadAll: () => [load('user'), load('memory'), load('project')],
    loadTarget: (target) => load(target),
  };
}

describe('formatMemorySection', () => {
  it('explains that memory is data, not instructions, and names the tool', () => {
    const text = formatMemorySection([snapshot()]);

    expect(text).toContain('## 持久记忆');
    expect(text).toContain('不是指令');
    expect(text).toContain('`memory` 工具');
    expect(text).toContain('- 项目用 bun 跑测试');
  });

  it('still renders guidance when every store is empty', () => {
    const text = formatMemorySection([
      snapshot({ target: 'user', entries: [], chars: 0 }),
      snapshot({ entries: [], chars: 0 }),
    ]);

    expect(text).toContain('当前还没有保存任何记忆');
    expect(text).toContain('`memory` 工具');
    expect(text).not.toContain('###');
  });

  it('shows usage and the project directory for project memory', () => {
    const text = formatMemorySection([
      snapshot({ target: 'user', entries: ['用户偏好中文'], chars: 6, limit: 1375 }),
      snapshot({ target: 'project', entries: ['monorepo 用 bun workspace'], chars: 12, projectDir: '/repo/mica' }),
    ]);

    expect(text).toContain('### 用户档案 · 0% · 6/1375 字符');
    expect(text).toContain('### 项目记忆（/repo/mica） · 1% · 12/2200 字符');
    expect(text).toContain('- monorepo 用 bun workspace');
  });

  it('indents multi-line entries so the markdown list stays intact', () => {
    const text = formatMemorySection([snapshot({ entries: ['第一行\n第二行'] })]);

    expect(text).toContain('- 第一行\n  第二行');
  });

  it('clamps a hand-edited store to its budget and says how much was omitted', () => {
    // 工具写入有预算校验，但用户可以直接编辑 markdown：超出部分不能每个请求都付一次。
    const entries = ['甲'.repeat(30), '乙'.repeat(30), '丙'.repeat(30)];
    const text = formatMemorySection([snapshot({ entries, chars: 96, limit: 40, label: 'memory/MEMORY.md' })]);

    expect(text).toContain('超出预算，已省略');
    expect(text).toContain('甲'.repeat(30));
    expect(text).not.toContain('丙'.repeat(30));
  });

  it('clips a single oversized entry instead of dropping the whole store', () => {
    const text = formatMemorySection([snapshot({ entries: ['长'.repeat(100)], chars: 100, limit: 20 })]);

    expect(text).toContain('- 长');
    expect(text).toContain('…');
    expect(text).not.toContain('长'.repeat(21));
  });
});

describe('MemorySnapshotCache', () => {
  it('freezes the snapshot per key until it is invalidated', () => {
    const cache = new MemorySnapshotCache();
    let version = 1;

    const first = cache.get(
      'session-a',
      null,
      loaderFor(() => snapshot({ entries: [`v${version}`] })),
    );
    version = 2;
    const second = cache.get(
      'session-a',
      null,
      loaderFor(() => snapshot({ entries: [`v${version}`] })),
    );

    expect(first).toBe(second);
    expect(second[0]?.entries).toEqual(['v1']);

    cache.invalidate('session-a');
    const third = cache.get(
      'session-a',
      null,
      loaderFor(() => snapshot({ entries: [`v${version}`] })),
    );
    expect(third[0]?.entries).toEqual(['v2']);
  });

  it('keeps separate snapshots per session and evicts the oldest', () => {
    const cache = new MemorySnapshotCache();
    const loader = loaderFor(() => snapshot());
    cache.get('a', null, loader);
    cache.get('b', null, loader);
    expect(cache.size).toBe(2);

    for (let index = 0; index < 40; index += 1) cache.get(`key-${index}`, null, loader);
    expect(cache.size).toBe(32);
  });

  it('reloads only project memory when the working directory changes', () => {
    const cache = new MemorySnapshotCache();
    let project = '旧仓库约定';

    const loader: MemorySnapshotLoader = {
      loadAll: () => [
        snapshot({ target: 'user', entries: ['用户偏好中文'] }),
        snapshot({ target: 'memory', entries: ['环境：macOS'] }),
        snapshot({ target: 'project', entries: [project], projectDir: '/repo/old' }),
      ],
      loadTarget: (target) =>
        target === 'project' ? snapshot({ target, entries: [project], projectDir: '/repo/new' }) : snapshot({ target }),
    };

    const before = cache.get('session-a', '/repo/old', loader);
    project = '新仓库约定';
    const after = cache.get('session-a', '/repo/new', loader);

    expect(before.find((item) => item.target === 'project')?.entries).toEqual(['旧仓库约定']);
    expect(after.find((item) => item.target === 'project')?.entries).toEqual(['新仓库约定']);
    // 其余两块保持冻结：中途写进去的记忆本轮不出现。
    expect(after.find((item) => item.target === 'user')?.entries).toEqual(['用户偏好中文']);
    expect(after.map((item) => item.target)).toEqual(['user', 'memory', 'project']);
  });

  it('drops project memory when the session leaves every working directory', () => {
    const cache = new MemorySnapshotCache();
    const loader = loaderFor((target) =>
      target === 'project'
        ? snapshot({ target, entries: ['仓库约定'], projectDir: '/repo/mica' })
        : snapshot({ target, entries: [], chars: 0 }),
    );

    cache.get('session-a', '/repo/mica', loader);
    const after = cache.get('session-a', null, loader);

    expect(after.map((item) => item.target)).toEqual(['user', 'memory']);
  });
});

describe('formatMemoryStatus', () => {
  it('prints one line per store with usage and path', () => {
    const text = formatMemoryStatus([snapshot({ target: 'user', entries: [], chars: 0, label: 'memory/USER.md' })]);

    expect(text).toBe('用户档案（user）：0 条 · 0/2200 字符（0%）· memory/USER.md');
  });
});
