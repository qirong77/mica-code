/**
 * 「最近访问」的展示侧逻辑：页面用它筛地址、走键盘、压短 URL，主进程用它判断
 * 哪些地址值得记。两侧共用一份，避免「顶栏筛出来的」和「记下来的」不是一套规则。
 *
 * 数据怎么存（按会话、留 50 条、浮层怎么摆）在 `apps/desktop/src/main/browser/browser-recents.js`。
 */

const URL_MAX = 4096;

/** 只认 http(s)：about:blank、data:、devtools: 这些不是「访问过的站点」。 */
export function isRecentUrl(url: unknown): boolean {
  const value = String(url ?? '').trim();
  return value.length <= URL_MAX && /^https?:\/\//i.test(value);
}

export interface RecentEntry {
  url: string;
  title?: string;
  at?: number;
}

/** 输入框里的文字 → 列表（不区分大小写的子串匹配；空串就是全部）。 */
export function filterRecent<T extends RecentEntry>(list: T[] | null | undefined, query: unknown): T[] {
  const items = Array.isArray(list) ? list : [];
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return items;
  return items.filter(
    (item) =>
      String(item?.url ?? '').toLowerCase().includes(needle) ||
      String(item?.title ?? '').toLowerCase().includes(needle),
  );
}

/**
 * 键盘高亮：只在有列表时成立；越界就收在两端，`-1` 表示没有高亮
 * （此时回车走输入框里的地址）。`step=0` 只做收敛，用来在列表变短后修正下标。
 */
export function moveHighlight(index: number, length: number, step: number): number {
  const count = Math.max(0, Number(length) || 0);
  if (!count) return -1;
  const current = Number.isInteger(index) ? index : -1;
  if (step === 0) return current >= 0 && current < count ? current : -1;
  const next = current < 0 ? (step > 0 ? 0 : count - 1) : current + step;
  return Math.min(count - 1, Math.max(0, next));
}

/** 地址栏里的第二行说明：去掉协议，保留主机与路径。 */
export function compactUrl(url: unknown): string {
  const raw = String(url ?? '');
  try {
    const parsed = new URL(raw);
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return `${parsed.host}${path === '/' ? '' : path.replace(/\/$/, '')}`;
  } catch {
    return raw;
  }
}
