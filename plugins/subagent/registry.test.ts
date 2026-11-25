import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_DEAD_ENTRIES, SubagentRegistry, resolveSubagentRole, type SubagentEntry } from './registry.js';

const startMock = vi.hoisted(() => vi.fn());

// 只替换起进程这一步：这里测的是登记表自己的行为，不该为此真的去起一个
// mica app-server（一次 2s 起，还会把真正的子进程留在测试机上）。
vi.mock('./subagentProcess.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./subagentProcess.js')>();
  return { ...actual, SubagentProcess: Object.assign(vi.fn(), { start: startMock }) };
});

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeRegistry(): SubagentRegistry {
  return new SubagentRegistry({ logger: noopLogger, health: { report() {} } } as never, null, '/tmp', () => undefined);
}

function fakeEntry(id: string, closed: boolean, createdAt = 1): SubagentEntry {
  return {
    id,
    title: id,
    cwd: '/tmp',
    createdAt,
    process: { closed, transcript: { allTurns: () => [], latestTurn: null, busy: false } },
  } as unknown as SubagentEntry;
}

/** 直接往登记表里塞条目：不经过 spawn，测的是登记表自己的行为。 */
function seed(registry: SubagentRegistry, entries: SubagentEntry[]): void {
  const target = registry as unknown as { entries: Map<string, SubagentEntry> };
  for (const entry of entries) target.entries.set(entry.id, entry);
}

beforeEach(() => {
  startMock.mockReset();
});

describe('resolveSubagentRole', () => {
  it('uses the explicitly requested role', () => {
    expect(resolveSubagentRole('paimon-bot', '需求开发')).toBe('paimon-bot');
  });

  it('inherits the parent role when none is requested', () => {
    // 子会话是「同一个 agent 换个上下文」；回落到 default 会让它换一套行为规则。
    expect(resolveSubagentRole(undefined, '需求开发')).toBe('需求开发');
  });

  it('ignores a blank explicit role and still inherits', () => {
    // 模型经常传空串而不是省略字段，不能因此丢掉父角色。
    expect(resolveSubagentRole('   ', '需求开发')).toBe('需求开发');
    expect(resolveSubagentRole('', '需求开发')).toBe('需求开发');
  });

  it('returns undefined when neither side names a role', () => {
    // undefined 让宿主用自己的默认值，而不是硬塞一个名字。
    expect(resolveSubagentRole(undefined, undefined)).toBeUndefined();
    expect(resolveSubagentRole('  ', '  ')).toBeUndefined();
  });

  it('trims before comparing so a padded name still wins', () => {
    expect(resolveSubagentRole('  paimon-bot  ', '需求开发')).toBe('paimon-bot');
  });

  it('treats invented placeholder words as "inherit"', () => {
    // 真实链路里模型会把 role 填成「当前角色」：照传就是 `Role not found: 当前角色`，
    // 子会话随即落到默认角色——父会话的角色等于被悄悄丢掉了。
    expect(resolveSubagentRole('当前角色', '需求开发')).toBe('需求开发');
    expect(resolveSubagentRole('父会话', '需求开发')).toBe('需求开发');
    expect(resolveSubagentRole('inherit', '需求开发')).toBe('需求开发');
  });

  it('still honors "default" because it is a real built-in role name', () => {
    expect(resolveSubagentRole('default', '需求开发')).toBe('default');
  });
});

describe('SubagentRegistry.get', () => {
  it('never matches everything on an empty id', () => {
    // 空前缀让 startsWith 恒真：只有一个子会话时，漏传 session_id 会静默命中它。
    const registry = makeRegistry();
    seed(registry, [fakeEntry('child-1', false)]);
    expect(registry.get('')).toBeNull();
    expect(registry.get('   ')).toBeNull();
  });

  it('resolves a unique prefix and refuses an ambiguous one', () => {
    const registry = makeRegistry();
    seed(registry, [fakeEntry('20261031T034058Z-z6w82c', false), fakeEntry('20261031T034146Z-ib4gf6', false)]);
    // 公共前缀命中两条：宁可让模型重给一个更长的前缀，也别猜它指的是哪一条。
    expect(registry.get('20261031T034')).toBeNull();
    expect(registry.get('20261031T034146Z')?.id).toBe('20261031T034146Z-ib4gf6');
    expect(registry.get('20261031T034058Z-z6w82c')?.id).toBe('20261031T034058Z-z6w82c');
  });
});

describe('SubagentRegistry.sweep', () => {
  it('keeps the newest dead entries and every live one', () => {
    const registry = makeRegistry();
    seed(registry, [
      ...Array.from({ length: MAX_DEAD_ENTRIES + 3 }, (_, index) => fakeEntry(`dead-${index}`, true, index)),
      fakeEntry('alive', false, 99),
    ]);
    registry.sweep();
    const ids = registry.list().map((entry) => entry.id);
    expect(ids).toContain('alive');
    // 留最近几条死条目：退出原因与最后一轮还能回看，但不会无限累积。
    expect(ids).not.toContain('dead-0');
    expect(ids.filter((id) => id.startsWith('dead-'))).toHaveLength(MAX_DEAD_ENTRIES);
  });
});
