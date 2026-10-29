import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DwsRunner } from './dws.js';
import {
  activeChats,
  formatDwsTime,
  matchTargets,
  refreshSchedules,
  toDateOnly,
  windowStart,
} from './refresh.js';

const NOW = new Date(2026, 9, 29, 20, 0, 0); // 2026-10-29 20:00 本地时间

let cacheDir = '';

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'mica-schedule-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

type FakeChat = { id: string; name: string; latestTs: number; messages: unknown[] };

/** 假的 dws：把「导出文件」直接写在命令行给的那个路径上，其余行为照真实命令的形状来。 */
function fakeRunner(chats: FakeChat[], behavior: { failChats?: string[] } = {}): DwsRunner {
  return async (args) => {
    if (args.includes('user')) {
      return JSON.stringify({ ok: true, data: { user: { fullname: '林棋熔 Qirong Lin' } } });
    }
    if (args.includes('+dump-chats')) {
      const file = args[args.length - 1]!;
      writeFileSync(
        file,
        JSON.stringify({
          ok: true,
          data: {
            chats: chats.map((chat) => ({
              vchannel_id: chat.id,
              name: chat.name,
              type: 'channel',
              latest_ts: chat.latestTs,
            })),
          },
        }),
      );
      return '';
    }
    const chatId = args[args.indexOf('--by-chat-id') + 1]!;
    if (behavior.failChats?.includes(chatId)) throw new Error('没有这个群的权限');
    const chat = chats.find((entry) => entry.id === chatId);
    const file = args[args.length - 1]!;
    writeFileSync(file, JSON.stringify({ ok: true, data: { messages: chat?.messages ?? [] } }));
    return '';
  };
}

function announcement(text: string, ts: number) {
  return { subtype: 'announcement', text, created_ts: ts, content: { author: { fullname: '王轩' } } };
}

const CHATS: FakeChat[] = [
  {
    id: '111',
    name: '违章处置线上化',
    latestTs: NOW.getTime() - 3_600_000,
    messages: [
      { subtype: 'normal', text: '好的', created_ts: NOW.getTime() - 7_200_000 },
      announcement('排期：10.15～10.21开发，测试：10.28-10.30，走查+上线：11.02', NOW.getTime() - 86_400_000),
      announcement('排期：10.15～10.21开发，测试：10.28-10.30，走查+上线：11.03', NOW.getTime() - 3_600_000),
    ],
  },
  {
    id: '222',
    name: '长租',
    latestTs: NOW.getTime() - 2 * 86_400_000,
    messages: [announcement('排期：开发：10.27-11.02，联调：11.03-11.09，上线：11.16', NOW.getTime())],
  },
  {
    id: '333',
    name: 'XFE 报警群',
    latestTs: NOW.getTime() - 2 * 3_600_000,
    messages: [{ subtype: 'normal', text: '又是同一个报警', created_ts: NOW.getTime() }],
  },
  {
    id: '444',
    name: '早就没人说话的群',
    latestTs: NOW.getTime() - 40 * 86_400_000,
    messages: [announcement('排期：上线：9.01', NOW.getTime() - 40 * 86_400_000)],
  },
];

describe('refreshSchedules', () => {
  it('自动挑活跃群，取最新一条公告，跳过没有排期的群', async () => {
    const outcome = await refreshSchedules({
      run: fakeRunner(CHATS),
      cacheDir,
      now: NOW,
      targets: [],
      days: 14,
    });

    expect(outcome.me).toBe('林棋熔 Qirong Lin');
    expect(outcome.planned).toBe(3); // 444 四十天没动静，不在活跃窗口里
    expect(outcome.scanned).toBe(3);
    // 有排期的两个群按公告时间倒序；XFE 报警群只有普通消息，不出现
    expect(outcome.groups.map((group) => group.name)).toEqual(['长租', '违章处置线上化']);
    // 同一个群改过两版公告时取后写的那一版
    const weizhang = outcome.groups.find((group) => group.name === '违章处置线上化')!;
    expect(weizhang.stages.find((stage) => stage.key === 'release')?.start).toBe('2026-11-03');
    expect(weizhang.author).toBe('王轩');
    expect(outcome.errors).toEqual([]);
    expect(outcome.partial).toBe(false);
  });

  it('点名的群按名字/id 匹配，匹配不到记一条原因', async () => {
    const outcome = await refreshSchedules({
      run: fakeRunner(CHATS),
      cacheDir,
      now: NOW,
      targets: ['222', '长租', '不存在的群'],
      days: 14,
    });

    expect(outcome.planned).toBe(1);
    expect(outcome.groups.map((group) => group.id)).toEqual(['222']);
    expect(outcome.errors).toEqual([
      { name: '不存在的群', message: '群列表里没有这个群（名字要写全，或者直接填群 id）' },
    ]);
  });

  it('单个群失败不影响其它群', async () => {
    const outcome = await refreshSchedules({
      run: fakeRunner(CHATS, { failChats: ['222'] }),
      cacheDir,
      now: NOW,
      targets: [],
      days: 14,
    });

    expect(outcome.groups.map((group) => group.name)).toEqual(['违章处置线上化']);
    expect(outcome.errors).toEqual([{ name: '长租', message: '没有这个群的权限' }]);
    expect(outcome.scanned).toBe(2);
  });

  it('群列表读不出来就是一次失败，不留半份结果', async () => {
    const failing: DwsRunner = async () => {
      throw new Error('dws 未登录');
    };
    await expect(
      refreshSchedules({ run: failing, cacheDir, now: NOW, targets: [], days: 14 }),
    ).rejects.toThrow('读不到群列表：dws 未登录');
  });
});

describe('时间窗口与目标匹配', () => {
  it('窗口起点是 N 天前的零点，含今天', () => {
    expect(windowStart(NOW, 14)).toEqual(new Date(2026, 9, 16, 0, 0, 0));
    expect(windowStart(NOW, 1)).toEqual(new Date(2026, 9, 29, 0, 0, 0));
    expect(toDateOnly(NOW)).toBe('2026-10-29');
    expect(formatDwsTime(NOW)).toBe('2026-10-29 20:00:00');
  });

  it('只认 channel、按活跃时间判断最近有没有人说话', () => {
    const chats = [
      { id: '1', name: 'A', type: 'channel', latestTs: NOW.getTime() - 3_600_000 },
      { id: '2', name: 'B', type: 'channel', latestTs: NOW.getTime() - 10 * 86_400_000 },
      { id: '3', name: 'C', type: 'p2p', latestTs: NOW.getTime() },
    ];
    expect(activeChats(chats, NOW, 7).map((chat) => chat.id)).toEqual(['1']);
  });

  it('群名可以模糊匹配，重复点名不会重复扫', () => {
    const chats = [
      { id: '1', name: '违章处置线上化', type: 'channel', latestTs: 0 },
      { id: '2', name: '违章处置线上化联调群', type: 'channel', latestTs: 0 },
    ];
    expect(matchTargets(chats, ['1', '违章处置线上化']).matched.map((chat) => chat.id)).toEqual(['1']);
    expect(matchTargets(chats, ['联调']).matched.map((chat) => chat.id)).toEqual(['2']);
    expect(matchTargets(chats, ['']).matched).toEqual([]);
  });
});
