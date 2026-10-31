// 一条模型请求的「来源」：统计页据此把主对话、委派子代理、插件与内核后台的用量摆在
// 同一张卡上。host 聚合与会话详情共用这一份判定，两侧不能各算一套。

export type UsageSourceKind = 'main' | 'delegation' | 'plugin' | 'helper';

export type UsageSource = {
  kind: UsageSourceKind;
  /** 同一 kind 内分组用的 id：`main` / 子代理类型 / 插件 id。 */
  id: string;
  /** 插件来源时发起请求的插件 id；其它来源为 null。 */
  pluginId: string | null;
};

export const USAGE_SOURCE_LABELS: Record<UsageSourceKind, string> = {
  main: 'Main',
  delegation: 'Delegated',
  plugin: 'Plugin',
  helper: 'Built-in',
};

/** 主对话（provider 主循环）的请求。整条会话里只有这一份来源的 id 是固定的。 */
export const MAIN_USAGE_SOURCE: UsageSource = { kind: 'main', id: 'main', pluginId: null };

export function usageSourceKey(source: UsageSource): string {
  return `${source.kind}:${source.id}`;
}

/**
 * 一条会话快照里真实的模型请求数：主对话 + 每一份 subagent/插件记录。
 * 只数 `usageHistory` 会漏掉委派与插件的开销，而它们进的是同一笔账。
 */
export function countUsageRequests(snapshot: {
  usageHistory?: unknown[] | null;
  subagentUsageHistory?: Array<{ requests?: unknown[] | null }> | null;
}): number {
  const main = Array.isArray(snapshot?.usageHistory) ? snapshot.usageHistory.length : 0;
  const records = Array.isArray(snapshot?.subagentUsageHistory) ? snapshot.subagentUsageHistory : [];
  return records.reduce(
    (total, record) => total + (Array.isArray(record?.requests) ? record.requests.length : 0),
    main,
  );
}

type SubagentUsageRecordLike = {
  origin?: string | null;
  pluginId?: string | null;
  subagentType?: string | null;
  initiatedByCallId?: string | null;
};

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 分类一条持久化的 subagent 记录（`snapshot.subagentUsageHistory` 里的一条）。
 *
 * 三条判据的顺序有讲究：
 *
 * 1. `origin: 'delegation'`，或带 `initiatedByCallId`（主对话经工具调用派出去）= 委派。
 *    委派本身由 subagent 插件提供，记录里可能也带着 `pluginId: 'subagent'`，但用户关心
 *    的是「这一笔是主对话派出去的活」，插件归属只作为细节；
 * 2. `origin: 'plugin'` 或有 `pluginId` → `plugin`：插件自己的模型请求，以及插件注册
 *    的子代理类型（memory-curator、旁问线程）；
 * 3. 其余 → `helper`：内核提供的后台请求（compact 摘要、桌面旁问抽屉）。老记录既没有
 *    `origin` 也没有 `pluginId`，落到这一类的正是它们。
 */
export function usageSourceOf(record: SubagentUsageRecordLike | null | undefined): UsageSource {
  const pluginId = trimmed(record?.pluginId);
  const subagentType = trimmed(record?.subagentType);
  if (record?.origin === 'delegation' || trimmed(record?.initiatedByCallId)) {
    return { kind: 'delegation', id: subagentType || 'delegation', pluginId: pluginId || null };
  }
  if (record?.origin === 'plugin' || pluginId) {
    return { kind: 'plugin', id: pluginId || subagentType || 'plugin', pluginId: pluginId || null };
  }
  return { kind: 'helper', id: subagentType || 'helper', pluginId: null };
}
