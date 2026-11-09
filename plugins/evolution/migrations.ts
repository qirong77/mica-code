import { isFindingAssessment } from '../harness-review/assessments.js';

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

/**
 * 压缩插件从 `auto-compact` 改名成 `session-compact`。
 *
 * 改名把两处旧写法一起收掉：会话快照里旧插件留下的计数与时间戳（`quickRuns` /
 * `modelRuns` / `lastRunAt` / `lastReminderAt` …，改成纯手动后没有人再读），以及内核在
 * 更早版本里给摘要子代理写下的 `subagentType: 'auto-compact'`（现在写作 `compact`）。
 * 留着这两处，后来的人会以为还有自动触发的逻辑。
 */
export const sessionCompactRename: Migration = {
  id: 'session-compact-rename',
  description: '清掉旧压缩插件（auto-compact）留下的会话状态，并把摘要子代理的旧写法归一为 compact',
  apply(document) {
    let changed = 0;
    const pluginState = document.pluginState;
    if (isRecord(pluginState) && 'auto-compact' in pluginState) {
      delete pluginState['auto-compact'];
      changed += 1;
    }
    const snapshot = document.snapshot;
    const records = isRecord(snapshot) ? snapshot.subagentUsageHistory : undefined;
    if (Array.isArray(records)) {
      for (const record of records) {
        if (!isRecord(record) || record.subagentType !== 'auto-compact') continue;
        record.subagentType = 'compact';
        changed += 1;
      }
    }
    return changed;
  },
};

/**
 * 删掉会话里存着的 provider 原始 usage（`rawUsage`）。
 *
 * 有些聚合网关会在 `usage` 里回传**逐条消息**的 token 归因（`attribution.items`，实测
 * 一份 1085 条、单条 200KB）。早先的版本把它原样写进会话，于是会话文件里 22% 是这份
 * 没有人读的数据：界面与统计读的是记录自身的 `inputTokens` / `outputTokens` /
 * `cachedInputTokens` / `totalTokens`，全仓没有任何代码读 `rawUsage`。
 *
 * 代价不只是磁盘：每次打开会话要整份 `JSON.parse`、每个 checkpoint 要整份
 * `JSON.stringify`、`chat:history` 要过一遍 IPC——那个 153MB 的会话，每次都扛着 74MB
 * 无人读取的账单。provider 侧已经不再写入，这里把存量一次清干净。
 *
 * 三处形状：主对话与「上一条用量」直接挂在记录上；子代理是「一个任务一条」，逐次请求在
 * `requests[]` 里。
 */
export const dropRawUsage: Migration = {
  id: 'drop-raw-usage',
  description: '删掉会话里无人读取的 provider 原始 usage（逐条 token 归因，单条可达 200KB）',
  apply(document) {
    const snapshot = document.snapshot;
    if (!isRecord(snapshot)) return 0;
    let changed = 0;
    const strip = (record: unknown) => {
      if (!isRecord(record)) return;
      if (!('rawUsage' in record)) return;
      delete record.rawUsage;
      changed += 1;
    };
    if (Array.isArray(snapshot.usageHistory)) {
      for (const record of snapshot.usageHistory) strip(record);
    }
    if (Array.isArray(snapshot.subagentUsageHistory)) {
      for (const record of snapshot.subagentUsageHistory) {
        if (isRecord(record) && Array.isArray(record.requests)) {
          for (const request of record.requests) strip(request);
        }
      }
    }
    strip(snapshot.lastUsage);
    return changed;
  },
};

/**
 * 一条非主对话的请求要能回答「哪个插件发起的」：Stats 的 By source 按这个字段把这些请求
 * 挂在插件（父级）下面。老记录只写了 `subagentType`，没写 `pluginId`，于是在界面上只能
 * 堆成一串没有归属的类型名（`Implementer`、`btw`）。
 *
 * 这里按当时的实现事实补上提供者，而不是让界面去猜：
 *
 * - 委派的子代理类型由 `subagent` 插件注册。名单只列它当时内置的那几个（见
 *   `plugins/subagent/definitions.ts`）——用户插件自己注册的类型不在名单里，保持原样，
 *   误标比不标更难查；
 * - `btw` 的旁问线程、`commit` 的提交说明、`memory-curator` 的记忆整理都是各自插件的
 *   功能，只是更早的宿主没把插件 id 写进记录；
 * - `compact`（`/compact` 与 `mica compact`）是内核自带的命令，没有插件可归属，不动。
 */
const DELEGATION_PROVIDER = 'subagent';
const BUILTIN_SUBAGENT_TYPES = new Set([
  'general-purpose',
  'Explore',
  'Implementer',
  'Reviewer',
  'Tester',
  'Planner',
  'Proposal',
]);
/** 记录里的功能 id → 提供这个功能的插件 id。 */
const FEATURE_PLUGINS: Record<string, string> = {
  btw: 'btw',
  commit: 'commit',
  'memory-curator': 'memory',
};

export const usageSourceOwner: Migration = {
  id: 'usage-source-owner',
  description: '给没有归属的用量记录补上发起它的插件（委派 → subagent，btw / commit / memory-curator → 各自插件）',
  apply(document) {
    const snapshot = document.snapshot;
    const records = isRecord(snapshot) ? snapshot.subagentUsageHistory : undefined;
    if (!Array.isArray(records)) return 0;
    let changed = 0;
    for (const record of records) {
      if (!isRecord(record)) continue;
      // 旧插件 id 改名（auto-compact → session-compact，见 session-compact-rename）。
      // 这条记录本来就有归属，只是名字过期了；不改会多出一个已经不存在的插件。
      if (record.pluginId === 'auto-compact') {
        record.pluginId = 'session-compact';
        changed += 1;
      }
      const current = typeof record.pluginId === 'string' ? record.pluginId.trim() : '';
      if (current) continue;
      const type = typeof record.subagentType === 'string' ? record.subagentType.trim() : '';
      const delegated =
        record.origin === 'delegation' ||
        (typeof record.initiatedByCallId === 'string' && record.initiatedByCallId.trim() !== '');
      if (delegated) {
        if (!BUILTIN_SUBAGENT_TYPES.has(type)) continue;
        record.pluginId = DELEGATION_PROVIDER;
        changed += 1;
        continue;
      }
      const pluginId = FEATURE_PLUGINS[type];
      if (!pluginId) continue;
      record.origin = 'plugin';
      record.pluginId = pluginId;
      changed += 1;
    }
    return changed;
  },
};

export const harnessReviewAssessmentV1: Migration = {
  id: 'harness-review-assessment-v1',
  description: 'Version legacy harness-review decisions without inventing an observed baseline',
  apply(document) {
    const keys = ['id', 'status', 'note', 'updatedAt'];
    if (!isRecord(document)) return 0;
    if (Object.keys(document).length !== keys.length || !keys.every((key) => Object.hasOwn(document, key))) return 0;
    if (!isFindingAssessment({ ...document, version: 1, baseline: null })) return 0;
    document.version = 1;
    document.baseline = null;
    return 1;
  },
};

export const generationTimingV2: Migration = {
  id: 'generation-timing-v2',
  description: '将无法与正文 token 对应的旧生成计时归档，保留用量与响应等待',
  apply(document) {
    const snapshot = document.snapshot;
    if (!isRecord(snapshot)) return 0;
    let changed = 0;
    const archive = (record: unknown) => {
      if (!isRecord(record) || !('generationDurationMs' in record) || 'generationOutputTokens' in record) return;
      if ('legacyGenerationDurationMs' in record) return;
      record.legacyGenerationDurationMs = record.generationDurationMs;
      delete record.generationDurationMs;
      changed += 1;
    };
    if (Array.isArray(snapshot.usageHistory)) snapshot.usageHistory.forEach(archive);
    if (Array.isArray(snapshot.subagentUsageHistory)) {
      for (const record of snapshot.subagentUsageHistory) {
        if (isRecord(record) && Array.isArray(record.requests)) record.requests.forEach(archive);
      }
    }
    archive(snapshot.lastUsage);
    return changed;
  },
};

export const MIGRATIONS: Migration[] = [
  usageOccurredAt,
  sessionCompactRename,
  dropRawUsage,
  usageSourceOwner,
  generationTimingV2,
];
