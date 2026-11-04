import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, dropRawUsage, usageOccurredAt, usageSourceOwner } from './migrations.js';
import { runEvolution } from './run.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function createHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'mica-evolution-'));
  homes.push(home);
  mkdirSync(join(home, 'sessions'), { recursive: true });
  return home;
}

function writeSession(home: string, id: string, document: unknown): string {
  const path = join(home, 'sessions', `${id}.json`);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return path;
}

function readSession(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function legacySession() {
  return {
    version: 1,
    id: 'session-1',
    title: '旧会话',
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T04:00:00.000Z',
    cwd: '/tmp/project',
    snapshot: {
      history: [],
      conversationMessages: [],
      usageHistory: [
        { inputTokens: 10, outputTokens: 5 },
        { inputTokens: 20, outputTokens: 8, occurredAt: '2026-01-02T03:30:00.000Z' },
      ],
      subagentUsageHistory: [
        {
          taskId: 'task-1',
          startedAt: '2026-01-02T03:10:00.000Z',
          requests: [{ inputTokens: 3, outputTokens: 1 }],
        },
      ],
    },
  };
}

describe('usage-occurred-at 迁移', () => {
  it('给主对话补会话创建时间、给子代理补任务开始时间，已有的记录不动', () => {
    const document = legacySession() as Record<string, any>;
    expect(usageOccurredAt.apply(document)).toBe(2);
    expect(document.snapshot.usageHistory[0].occurredAt).toBe('2026-01-02T03:04:05.000Z');
    expect(document.snapshot.usageHistory[1].occurredAt).toBe('2026-01-02T03:30:00.000Z');
    expect(document.snapshot.subagentUsageHistory[0].requests[0].occurredAt).toBe('2026-01-02T03:10:00.000Z');
  });

  it('重复执行没有改动', () => {
    const document = legacySession() as Record<string, any>;
    usageOccurredAt.apply(document);
    expect(usageOccurredAt.apply(document)).toBe(0);
  });

  it('会话没有可用的创建时间时不写一个假时间', () => {
    const document = legacySession() as Record<string, any>;
    document.createdAt = 'not-a-time';
    document.snapshot.subagentUsageHistory[0].startedAt = 'not-a-time';
    expect(usageOccurredAt.apply(document)).toBe(0);
    expect(document.snapshot.usageHistory[0].occurredAt).toBeUndefined();
  });

  it('形状不对的文档不算改动', () => {
    expect(usageOccurredAt.apply({ createdAt: '2026-01-02T03:04:05.000Z' })).toBe(0);
    expect(usageOccurredAt.apply({ snapshot: { usageHistory: 'nope' } })).toBe(0);
  });
});

describe('drop-raw-usage 迁移', () => {
  /** 生产里的三处形状：主对话、子代理的逐次请求、上一条用量。 */
  function withRawUsage() {
    const raw = {
      prompt_tokens: 10,
      attribution: { items: { msg_1: { input_tokens: 10 } } },
    };
    return {
      createdAt: '2026-01-02T03:04:05.000Z',
      snapshot: {
        usageHistory: [{ inputTokens: 10, rawUsage: raw }],
        subagentUsageHistory: [
          { taskId: 'task-1', requests: [{ inputTokens: 3, rawUsage: raw }], summary: { records: 1 } },
        ],
        lastUsage: { inputTokens: 10, rawUsage: raw },
      },
    } as Record<string, any>;
  }

  it('三处原始 usage 都删掉，token 数字原样保留', () => {
    const document = withRawUsage();
    expect(dropRawUsage.apply(document)).toBe(3);
    expect(document.snapshot.usageHistory[0]).toEqual({ inputTokens: 10 });
    expect(document.snapshot.subagentUsageHistory[0].requests[0]).toEqual({ inputTokens: 3 });
    expect(document.snapshot.subagentUsageHistory[0].summary).toEqual({ records: 1 });
    expect(document.snapshot.lastUsage).toEqual({ inputTokens: 10 });
  });

  it('重复执行没有改动', () => {
    const document = withRawUsage();
    dropRawUsage.apply(document);
    expect(dropRawUsage.apply(document)).toBe(0);
  });

  it('形状不对的文档不算改动', () => {
    expect(dropRawUsage.apply({})).toBe(0);
    expect(dropRawUsage.apply({ snapshot: { usageHistory: 'nope' } })).toBe(0);
    expect(dropRawUsage.apply({ snapshot: { usageHistory: [null, 3] } })).toBe(0);
  });
});

describe('usage-source-owner 迁移', () => {
  function withRecords(records: unknown[]) {
    return { snapshot: { subagentUsageHistory: records } } as Record<string, any>;
  }

  it('委派的子代理补上提供者，插件后台请求补上所属插件', () => {
    const document = withRecords([
      // 主对话经工具派出去的内置类型：由 subagent 插件提供。
      { taskId: 't1', initiatedByCallId: 'call-1', subagentType: 'Explore' },
      { taskId: 't2', origin: 'delegation', subagentType: 'Implementer' },
      // 插件自己的后台功能：更早的宿主没写插件 id。
      { taskId: 'btw', subagentType: 'btw' },
      { taskId: 'commit-message', subagentType: 'commit' },
      { taskId: 'memory', subagentType: 'memory-curator' },
    ]);

    expect(usageSourceOwner.apply(document)).toBe(5);
    const [delegated, explicitDelegation, btw, commit, memory] =
      document.snapshot.subagentUsageHistory;
    expect(delegated.pluginId).toBe('subagent');
    // 委派的 origin 不因为补了插件 id 而变化：它仍是主对话派出去的活。
    expect(delegated.origin).toBeUndefined();
    expect(explicitDelegation).toMatchObject({ origin: 'delegation', pluginId: 'subagent' });
    expect(btw).toMatchObject({ origin: 'plugin', pluginId: 'btw' });
    expect(commit).toMatchObject({ origin: 'plugin', pluginId: 'commit' });
    expect(memory).toMatchObject({ origin: 'plugin', pluginId: 'memory' });
  });

  it('内核命令（compact）与迁移名单外的类型不动', () => {
    const document = withRecords([
      { taskId: 'compact-summary', subagentType: 'compact' },
      // 用户插件注册的类型：不知道是谁提供的，就不猜。
      { taskId: 'custom', initiatedByCallId: 'call-2', subagentType: 'my-plugin-agent' },
    ]);
    expect(usageSourceOwner.apply(document)).toBe(0);
    expect(document.snapshot.subagentUsageHistory[0]).toEqual({
      taskId: 'compact-summary',
      subagentType: 'compact',
    });
  });

  it('已经有 pluginId 的记录不动，重复执行没有改动', () => {
    const document = withRecords([
      { taskId: 't1', origin: 'delegation', pluginId: 'my-plugin', subagentType: 'Explore' },
      { taskId: 't2', origin: 'plugin', pluginId: 'memory', subagentType: 'memory-curator' },
    ]);
    expect(usageSourceOwner.apply(document)).toBe(0);
    const again = withRecords([{ taskId: 't1', initiatedByCallId: 'call-1', subagentType: 'Explore' }]);
    expect(usageSourceOwner.apply(again)).toBe(1);
    expect(usageSourceOwner.apply(again)).toBe(0);
  });

  it('形状不对的文档不算改动', () => {
    expect(usageSourceOwner.apply({})).toBe(0);
    expect(usageSourceOwner.apply({ snapshot: 'nope' })).toBe(0);
    expect(usageSourceOwner.apply({ snapshot: { subagentUsageHistory: [null, 3] } })).toBe(0);
  });

  it('旧插件 id（auto-compact）改名成现在的 session-compact', () => {
    const document = withRecords([
      { taskId: 't1', origin: 'plugin', pluginId: 'auto-compact', subagentType: 'compact' },
    ]);
    expect(usageSourceOwner.apply(document)).toBe(1);
    expect(document.snapshot.subagentUsageHistory[0].pluginId).toBe('session-compact');
    expect(usageSourceOwner.apply(document)).toBe(0);
  });
});

describe('runEvolution', () => {
  it('把旧数据就地改写成当前形态，并记账跳过没变过的文件', async () => {
    const home = createHome();
    const path = writeSession(home, 'session-1', legacySession());
    const noLock = () => ({ release() {} });

    const first = await runEvolution({ home, lockSession: noLock });
    expect(first.outcome).toBe('ok');
    expect(first.migratedFiles).toBe(1);
    expect(first.migratedRecords).toBe(2);
    expect(first.pending).toBe(0);
    expect(readSession(path).snapshot.usageHistory[0].occurredAt).toBe('2026-01-02T03:04:05.000Z');

    const second = await runEvolution({ home, lockSession: noLock });
    expect(second.evaluated).toBe(0);
    expect(second.migratedFiles).toBe(0);

    const state = JSON.parse(readFileSync(join(home, 'plugin-data', 'evolution', 'state.json'), 'utf-8'));
    expect(state.files['session-1'].migrations).toEqual(MIGRATIONS.map((migration) => migration.id));
  });

  it('拿不到会话锁时留给下一轮，不碰文件', async () => {
    const home = createHome();
    const path = writeSession(home, 'session-1', legacySession());

    const result = await runEvolution({ home, lockSession: () => null });
    expect(result.busyFiles).toBe(1);
    expect(result.migratedFiles).toBe(0);
    expect(result.pending).toBe(1);
    expect(readSession(path).snapshot.usageHistory[0].occurredAt).toBeUndefined();
  });

  it('备份只留首次快照，坏文件签名不变就不再重试', async () => {
    const home = createHome();
    writeSession(home, 'session-1', legacySession());
    writeFileSync(join(home, 'sessions', 'broken.json'), '{ not json');

    const first = await runEvolution({ home, lockSession: () => ({ release() {} }) });
    expect(first.migratedFiles).toBe(1);
    expect(first.brokenFiles).toBe(1);
    const backup = readSession(join(home, 'plugin-data', 'evolution', 'backups', 'session-1.json'));
    expect(backup.snapshot.usageHistory[0].occurredAt).toBeUndefined();

    const second = await runEvolution({ home, lockSession: () => ({ release() {} }) });
    expect(second.evaluated).toBe(0);
    expect(second.brokenFiles).toBe(0);
  });
});
