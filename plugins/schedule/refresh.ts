import { parseSchedule, type ScheduleStage } from './parse.js';
import { latestAnnouncement, listChats, readSelf, type DwsChat, type DwsRunner } from './dws.js';

/**
 * 一轮「整理排期」：找出要看哪些群、逐个导出公告、解析成阶段。
 *
 * 群的数量直接决定这一轮要跑多久（一个群一次导出，实测 3～4 秒），所以这里有两道刹车：
 * 并发上限（同一时刻只压几个群）和整轮预算（超了就不再开新的，把已经扫到的先交出去）。
 * 宁可少几个群，也不要让侧栏卡在「刷新中」里转三分钟。
 */

/** 有排期的群。没有排期的群不进这个列表——它们只贡献 `scanned` 计数。 */
export type ScheduleGroup = {
  id: string;
  name: string;
  /** 公告最后一次改动的时间（毫秒）。 */
  announcedAt: number;
  /** 改公告的人。 */
  author: string;
  stages: ScheduleStage[];
};

export type RefreshOutcome = {
  /** 当前登录的人（`user info --self`），拿不到是空串。 */
  me: string;
  /** 实际扫了几个群。 */
  scanned: number;
  /** 这一轮打算扫几个群；比 `scanned` 大说明预算用完没扫全。 */
  planned: number;
  /** 本轮范围与成功读取的群，用来保留超时或失败时尚未更新的缓存。 */
  targetIds: string[];
  scannedIds: string[];
  groups: ScheduleGroup[];
  /** 具体某个群失败的原因；展示时只取前几条。 */
  errors: Array<{ name: string; message: string }>;
  /** 预算用完时还有群没扫，界面要说清「这次没扫全」。 */
  partial: boolean;
};

export type RefreshRequest = {
  run: DwsRunner;
  /** 导出文件的临时目录，跑完不留东西。 */
  cacheDir: string;
  now: Date;
  /** 设置里点名的群（群名或群 id）；空数组表示自动挑最近活跃的群。 */
  targets: string[];
  /** 回看多少个自然日内的公告（dws 单次上限 30）。 */
  days: number;
  /** 自动发现时，「活跃」指最近几天有消息。 */
  activeDays?: number;
  concurrency?: number;
  budgetMs?: number;
  onProgress?: (done: number, total: number) => void;
};

const MAX_LIMIT = 3000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_BUDGET_MS = 240_000;

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0');
}

/** `YYYY-MM-DD HH:MM:SS`，dws 的时间窗口参数要这个形状。 */
export function formatDwsTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 窗口起点：往前推 `days` 天的零点，避免「14 天」变成 13 天半。 */
export function windowStart(now: Date, days: number): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (days - 1));
  return start;
}

/** 设置里点名的群怎么落到真实的群上：先认 id，再认完整群名，最后按名字模糊匹配。 */
export function matchTargets(chats: DwsChat[], targets: string[]): { matched: DwsChat[]; missing: string[] } {
  const matched: DwsChat[] = [];
  const missing: string[] = [];
  for (const target of targets) {
    const value = target.trim();
    if (!value) continue;
    const chat =
      chats.find((entry) => entry.id === value) ??
      chats.find((entry) => entry.name === value) ??
      chats.find((entry) => entry.name.includes(value));
    if (!chat) {
      missing.push(value);
      continue;
    }
    if (!matched.some((entry) => entry.id === chat.id)) matched.push(chat);
  }
  return { matched, missing };
}

/** 没点名时看最近活跃的群：排期只可能出现在有人说话的群里。 */
export function activeChats(chats: DwsChat[], now: Date, activeDays: number): DwsChat[] {
  const since = now.getTime() - activeDays * 86_400_000;
  return chats
    .filter((chat) => chat.type === 'channel' && chat.latestTs >= since)
    .sort((left, right) => right.latestTs - left.latestTs);
}

export async function refreshSchedules(request: RefreshRequest): Promise<RefreshOutcome> {
  const concurrency = Math.max(1, request.concurrency ?? DEFAULT_CONCURRENCY);
  const budgetMs = request.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const days = Math.min(30, Math.max(1, Math.round(request.days)));

  const [me, chats] = await Promise.all([
    readSelf(request.run, Math.max(1, Math.min(20_000, budgetMs))),
    listChats(request.run, request.cacheDir, Math.max(1, Math.min(120_000, budgetMs))).catch((error) => {
      throw new Error(`读不到群列表：${error instanceof Error ? error.message : String(error)}`);
    }),
  ]);

  const named = matchTargets(chats, request.targets);
  const targets = request.targets.some((target) => target.trim())
    ? named.matched
    : activeChats(chats, request.now, request.activeDays ?? 7);
  const from = formatDwsTime(windowStart(request.now, days));
  const to = formatDwsTime(request.now);

  const groups: ScheduleGroup[] = [];
  const errors: Array<{ name: string; message: string }> = named.missing.map((name) => ({
    name,
    message: '群列表里没有这个群（名字要写全，或者直接填群 id）',
  }));
  let scanned = 0;
  const scannedIds: string[] = [];
  let partial = false;
  let next = 0;

  const report = () => request.onProgress?.(scanned + errors.length, targets.length);

  const worker = async (): Promise<void> => {
    for (;;) {
      if (Date.now() > deadline) {
        // 预算用完：剩下的群这轮不扫，交给界面说明「没扫全」
        if (next < targets.length) partial = true;
        return;
      }
      const index = next++;
      if (index >= targets.length) return;
      const chat = targets[index]!;
      try {
        const announcement = await latestAnnouncement(request.run, {
          chatId: chat.id,
          from,
          to,
          cacheDir: request.cacheDir,
          limit: MAX_LIMIT,
          timeoutMs: Math.max(1, Math.min(60_000, deadline - Date.now())),
        });
        scanned += 1;
        scannedIds.push(chat.id);
        // 没公告、公告里没排期都是正常情况：这个群这一轮只是不贡献条目
        const stages = announcement
          ? parseSchedule(announcement.text, {
              reference: toDateOnly(announcement.updatedAt > 0 ? new Date(announcement.updatedAt) : request.now),
            })
          : [];
        if (announcement && stages.length > 0) {
          groups.push({
            id: chat.id,
            name: chat.name,
            announcedAt: announcement.updatedAt,
            author: announcement.author,
            stages,
          });
        }
      } catch (error) {
        errors.push({
          name: chat.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      report();
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));

  groups.sort((left, right) => right.announcedAt - left.announcedAt);
  return {
    me,
    scanned,
    planned: targets.length,
    targetIds: targets.map((chat) => chat.id),
    scannedIds,
    groups,
    errors,
    partial,
  };
}

/** 没读到某个群的新公告时保留旧值；成功读到空公告才移除旧阶段。 */
export function mergeRefreshedGroups(previous: ScheduleGroup[], outcome: RefreshOutcome): ScheduleGroup[] {
  const targets = new Set(outcome.targetIds);
  const scanned = new Set(outcome.scannedIds);
  const retained = previous.filter((group) => targets.has(group.id) && !scanned.has(group.id));
  return [...outcome.groups, ...retained].sort((left, right) => right.announcedAt - left.announcedAt);
}

/** 参考日期（`YYYY-MM-DD`）：解析公告时用它补年份。 */
export function toDateOnly(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
