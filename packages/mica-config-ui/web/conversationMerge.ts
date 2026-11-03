import type { ConfigWebConversationItem } from '../src/shared/types.js';

/**
 * 把最新一页并进已经加载的列表。
 *
 * 只用最新一页替换整份列表有两个代价：用户翻上去的那几页会被丢掉（列表从几百条缩回
 * 一页，滚动位置跟着乱跳），而且每 2 秒一次的快照轮询都会换掉整份数组，整块重渲染。
 * 并入之后只改真正变了的那几条。
 *
 * 返回原数组表示「什么都没变」——调用方据此跳过 setState，轮询就不再引起重渲染。
 */
export function mergeConversationPage(
  loaded: ConfigWebConversationItem[],
  latest: ConfigWebConversationItem[],
): ConfigWebConversationItem[] {
  if (loaded.length === 0) return latest.length === 0 ? loaded : latest;
  if (latest.length === 0) return loaded;
  const bySequence = new Map(loaded.map((item) => [item.sequence, item] as const));
  let touched = false;
  for (const item of latest) {
    const existing = bySequence.get(item.sequence);
    if (existing && sameItem(existing, item)) continue;
    bySequence.set(item.sequence, item);
    touched = true;
  }
  if (!touched) return loaded;
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

function sameItem(left: ConfigWebConversationItem, right: ConfigWebConversationItem): boolean {
  return left.type === right.type && left.content === right.content && left.callId === right.callId;
}
