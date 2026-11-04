/**
 * 旧数据迁移：把 mica 某个历史形态的持久化数据就地改成当前形态。
 *
 * 这不是运行时兼容层——运行时代码只认当前形态，旧形态靠这里在升级后一次性洗干净。
 * 所以每条迁移都必须满足：
 *
 * - 幂等：已经是新形态的数据跑一遍改动数为 0，重复执行没有副作用；
 * - 只增补/改名，不删除用户数据（会话、用量、设置）；
 * - 判断依据只看文档本身，不依赖进程状态或外部服务。
 */
export type Migration = {
  /** 稳定标识，写进状态文件；改名等于重跑一条新迁移。 */
  id: string;
  /** 一句话说明这条迁移把旧数据改成什么，显示在 `/evolution status` 与日志里。 */
  description: string;
  /** 就地改写文档，返回本次改动的记录数；0 表示这份数据已经是新形态。 */
  apply(document: Record<string, unknown>): number;
};

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function validTimeText(value: unknown): string | null {
  return parseTime(value) === null ? null : (value as string);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 给一组用量记录补上 `occurredAt`，返回补了几条。 */
function fillOccurredAt(records: unknown, fallback: string): number {
  if (!Array.isArray(records)) return 0;
  let changed = 0;
  for (const record of records) {
    if (!isRecord(record)) continue;
    if (parseTime(record.occurredAt) !== null) continue;
    record.occurredAt = fallback;
    changed += 1;
  }
  return changed;
}

/**
 * 请求时间 `occurredAt` 是后加的字段：更早的版本只记 token，不记这一条请求发生在什么时候，
 * 统计页只能把整条记录归档到会话创建日。
 *
 * 迁移把当时的兜底估计写成真实字段（主对话用会话创建时间，子代理/插件请求用任务开始时间），
 * 于是新代码不再需要「这条记录准不准」的分支。估计值不是精确时间，但比留空更接近事实，
 * 且一旦写入就不再变化。
 */
export const usageOccurredAt: Migration = {
  id: 'usage-occurred-at',
  description: '给没有请求时间的用量记录补上 occurredAt（主对话取会话创建时间，子代理取任务开始时间）',
  apply(document) {
    const createdAt = validTimeText(document.createdAt);
    if (!createdAt) return 0;
    const snapshot = document.snapshot;
    if (!isRecord(snapshot)) return 0;

    let changed = fillOccurredAt(snapshot.usageHistory, createdAt);
    const subagentRecords = Array.isArray(snapshot.subagentUsageHistory) ? snapshot.subagentUsageHistory : [];
    for (const record of subagentRecords) {
      if (!isRecord(record)) continue;
      changed += fillOccurredAt(record.requests, validTimeText(record.startedAt) ?? createdAt);
    }
    return changed;
  },
};

/** 当前全部迁移，按顺序执行。新增形态变化就往这里加一条。 */
export const MIGRATIONS: Migration[] = [usageOccurredAt];
