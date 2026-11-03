import { describe, expect, it } from 'vitest';
import { MemorySnapshotCache, clampEntries, formatMemorySection, formatMemoryStatus } from './section.js';
import type { MemoryStoreSnapshot } from './store.js';
import type { MemoryScope } from './scope.js';

const PROFILE: MemoryScope = { kind: 'profile' };

function snapshot(overrides: Partial<MemoryStoreSnapshot> = {}): MemoryStoreSnapshot {
  const entries = overrides.entries ?? ['一条记忆'];
  return {
    scope: PROFILE,
    key: 'profile',
    title: '用户档案',
    path: '/tmp/profile.md',
    label: 'PROFILE.md',
    entries,
    chars: entries.join('\n\n').length,
    budget: 1200,
    ...overrides,
  };
}

describe('formatMemorySection', () => {
  it('renders nothing at all when no applicable layer has entries', () => {
    // 「当前没有记忆」这种占位句会在每个一次性会话里白烧 token。
    expect(formatMemorySection([])).toBe('');
    expect(formatMemorySection([snapshot({ entries: [], chars: 0 })])).toBe('');
  });

  it('renders the layers that apply and nothing else', () => {
    const section = formatMemorySection([
      snapshot({ title: '用户档案', entries: ['用户常用中文'] }),
      snapshot({ title: '项目记忆 · mica-code', key: 'project:mica', entries: ['测试用 bun run test'] }),
    ]);

    expect(section).toContain('用户档案');
    expect(section).toContain('用户常用中文');
    expect(section).toContain('项目记忆 · mica-code');
    expect(section).toContain('测试用 bun run test');
    expect(section).not.toContain('领域记忆');
  });

  it('skips a layer whose store is empty instead of printing an empty heading', () => {
    const section = formatMemorySection([
      snapshot({ title: '用户档案', entries: ['用户常用中文'] }),
      snapshot({ title: '领域记忆 · 租车', key: 'domain:zuche', entries: [] }),
    ]);

    expect(section).toContain('用户档案');
    expect(section).not.toContain('领域记忆');
  });

  it('keeps pinned entries ahead of unpinned ones', () => {
    const section = formatMemorySection([snapshot({ entries: ['普通一', '! 置顶这条', '普通二'] })]);

    const lines = section.split('\n');
    const pinned = lines.findIndex((line) => line.includes('置顶这条'));
    const plain = lines.findIndex((line) => line.includes('普通一'));
    expect(pinned).toBeGreaterThan(-1);
    expect(pinned).toBeLessThan(plain);
  });

  it('hides the pin marker from the rendered text', () => {
    const section = formatMemorySection([snapshot({ entries: ['! 置顶这条'] })]);

    expect(section).toContain('- 置顶这条');
    expect(section).not.toContain('- ! 置顶这条');
  });

  it('never mentions the write workflow', () => {
    // 写法属于工具描述；注入段落只放事实，否则每个会话都要为一段说明书付 token。
    const section = formatMemorySection([snapshot()]);

    expect(section).not.toContain('memory 工具');
    expect(section).not.toContain('三个月后');
  });

  it('indents continuation lines so multi-line entries stay one list item', () => {
    const section = formatMemorySection([snapshot({ entries: ['第一行\n第二行'] })]);

    expect(section).toContain('- 第一行\n  第二行');
  });

  it('reports how many earlier entries were left out', () => {
    const entries = ['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60)];
    const section = formatMemorySection([snapshot({ entries, budget: 70 })]);

    expect(section).toContain('另有 2 条更早的未展示');
    expect(section).not.toContain('b'.repeat(60));
  });
});

describe('clampEntries', () => {
  it('keeps everything when the budget is large enough', () => {
    expect(clampEntries(snapshot({ entries: ['a', 'b'], budget: 100 }))).toEqual({
      entries: ['a', 'b'],
      dropped: 0,
      clipped: false,
    });
  });

  it('clips a single entry that alone exceeds the budget', () => {
    const result = clampEntries(snapshot({ entries: ['x'.repeat(200)], budget: 50 }));

    expect(result.clipped).toBe(true);
    expect(result.entries[0]).toHaveLength(50);
    expect(result.entries[0]?.endsWith('…')).toBe(true);
  });

  it('counts the separator cost between entries', () => {
    // 两条各 30 字符、预算 61：加上分隔的 2 字符刚好放不下第二条。
    const result = clampEntries(snapshot({ entries: ['a'.repeat(30), 'b'.repeat(30)], budget: 61 }));
    expect(result.entries).toHaveLength(1);
    expect(result.dropped).toBe(1);
  });

  it('does not depend on the pin flag for ordering stability', () => {
    const entries = ['! pinned', 'one', 'two', 'three'];
    const result = clampEntries(snapshot({ entries, budget: 1_000 }));
    expect(result.entries).toEqual(['! pinned', 'one', 'two', 'three']);
  });
});

describe('MemorySnapshotCache', () => {
  it('returns the cached snapshot while the signature is unchanged', () => {
    const cache = new MemorySnapshotCache();
    let loads = 0;
    const loader = {
      load: () => {
        loads += 1;
        return [snapshot()];
      },
    };

    cache.get('session-1', 'mica-code', loader, [PROFILE]);
    cache.get('session-1', 'mica-code', loader, [PROFILE]);

    expect(loads).toBe(1);
  });

  it('reloads when the scope signature changes', () => {
    // `/cd` 到另一个仓库之后，注入的项目记忆必须跟着换。
    const cache = new MemorySnapshotCache();
    let loads = 0;
    const loader = {
      load: () => {
        loads += 1;
        return [snapshot({ entries: [`load-${loads}`] })];
      },
    };

    expect(cache.get('session-1', 'mica-code', loader, [PROFILE])[0]?.entries).toEqual(['load-1']);
    expect(cache.get('session-1', 'mica-code', loader, [PROFILE])[0]?.entries).toEqual(['load-1']);
    expect(cache.get('session-1', 'other-repo', loader, [PROFILE])[0]?.entries).toEqual(['load-2']);
  });

  it('keeps sessions apart', () => {
    const cache = new MemorySnapshotCache();
    const first = { load: () => [snapshot({ entries: ['a'] })] };
    const second = { load: () => [snapshot({ entries: ['b'] })] };

    cache.get('session-1', 'sig', first, [PROFILE]);
    expect(cache.get('session-2', 'sig', second, [PROFILE])[0]?.entries).toEqual(['b']);
  });

  it('drops a single session on invalidate and everything without a key', () => {
    const cache = new MemorySnapshotCache();
    const loader = { load: () => [snapshot()] };
    cache.get('a', 'sig', loader, [PROFILE]);
    cache.get('b', 'sig', loader, [PROFILE]);

    cache.invalidate('a');
    expect(cache.size).toBe(1);
    cache.invalidate();
    expect(cache.size).toBe(0);
  });

  it('evicts the oldest session past the cap', () => {
    const cache = new MemorySnapshotCache();
    const loader = { load: () => [snapshot()] };
    for (let index = 0; index < 40; index += 1) cache.get(`session-${index}`, 'sig', loader, [PROFILE]);

    expect(cache.size).toBe(32);
  });
});

describe('formatMemoryStatus', () => {
  it('reports count, pin count and usage per layer', () => {
    const status = formatMemoryStatus([snapshot({ entries: ['! a', 'b'], chars: 10, budget: 100 })]);

    expect(status).toContain('用户档案：2 条（1 条 pin）');
    expect(status).toContain('10/100 字符（10%）');
    expect(status).toContain('PROFILE.md');
  });
});
