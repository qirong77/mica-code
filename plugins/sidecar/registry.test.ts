import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_DEAD_ENTRIES, MAX_SIDECARS, SidecarRegistry, resolveSidecarRole, type SidecarEntry } from './registry.js';

const startMock = vi.hoisted(() => vi.fn());

// 只替换起进程这一步：名额判定要的是「登记表里还活着几条」，不该为此真的去起
// 一个 mica app-server（一次 2s 起，还会把真正的子进程留在测试机上）。
vi.mock('./sidecarProcess.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sidecarProcess.js')>();
  return { ...actual, SidecarProcess: Object.assign(vi.fn(), { start: startMock }) };
});

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeRegistry(): SidecarRegistry {
  return new SidecarRegistry({ logger: noopLogger, health: { report() {} } } as never, null, '/tmp', () => undefined);
}

function fakeEntry(id: string, closed: boolean, createdAt = 1): SidecarEntry {
  return {
    id,
    title: id,
    cwd: '/tmp',
    createdAt,
    process: { closed, transcript: { allTurns: () => [], latestTurn: null, busy: false } },
  } as unknown as SidecarEntry;
}

function fakeProcess(id: string): unknown {
  return {
    sessionId: id,
    cwd: '/tmp',
    closed: false,
    transcript: { allTurns: () => [], latestTurn: null, busy: false },
    send: async () => ({ queued: false }),
    close: async () => undefined,
  };
}

/** 直接往登记表里塞条目：不经过 spawn，测的是登记表自己的行为。 */
function seed(registry: SidecarRegistry, entries: SidecarEntry[]): void {
  const target = registry as unknown as { entries: Map<string, SidecarEntry> };
  for (const entry of entries) target.entries.set(entry.id, entry);
}

beforeEach(() => {
  startMock.mockReset();
});

describe('resolveSidecarRole', () => {
  it('uses the explicitly requested role', () => {
    expect(resolveSidecarRole('paimon-bot', '需求开发')).toBe('paimon-bot');
  });

  it('inherits the parent role when none is requested', () => {
    // 子会话是「同一个 agent 换个上下文」；回落到 default 会让它换一套行为规则。
    expect(resolveSidecarRole(undefined, '需求开发')).toBe('需求开发');
  });

  it('ignores a blank explicit role and still inherits', () => {
    // 模型经常传空串而不是省略字段，不能因此丢掉父角色。
    expect(resolveSidecarRole('   ', '需求开发')).toBe('需求开发');
    expect(resolveSidecarRole('', '需求开发')).toBe('需求开发');
  });

  it('returns undefined when neither side names a role', () => {
    // undefined 让宿主用自己的默认值，而不是硬塞一个名字。
    expect(resolveSidecarRole(undefined, undefined)).toBeUndefined();
    expect(resolveSidecarRole('  ', '  ')).toBeUndefined();
  });

  it('trims before comparing so a padded name still wins', () => {
    expect(resolveSidecarRole('  paimon-bot  ', '需求开发')).toBe('paimon-bot');
  });
});

describe('SidecarRegistry.get', () => {
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

describe('SidecarRegistry concurrency cap', () => {
  it('counts live processes, not dead leftovers', async () => {
    const registry = makeRegistry();
    seed(registry, Array.from({ length: MAX_SIDECARS }, (_, index) => fakeEntry(`dead-${index}`, true, index)));
    startMock.mockResolvedValue(fakeProcess('child-new'));
    const result = await registry.spawn({ prompt: 'x' });
    // 死条目占着名额时的表现是「已经有 4 个在跑」，可实际一个都没跑。
    expect(result.ok).toBe(true);
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('refuses once MAX_SIDECARS processes are alive', async () => {
    const registry = makeRegistry();
    seed(registry, Array.from({ length: MAX_SIDECARS }, (_, index) => fakeEntry(`live-${index}`, false, index)));
    const result = await registry.spawn({ prompt: 'x' });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('已经有');
    expect(startMock).not.toHaveBeenCalled();
  });
});

describe('SidecarRegistry.sweep', () => {
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
