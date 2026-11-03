import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 「手机端页面落后」这条提示的**一次性**语义。
 *
 * 页面落后是一个持续时间很长的状态：本机构建不变、中转机上的那份也不变，它可以一连几天
 * 都是「落后」。可提示点只应该提醒**一次**——每 3 秒重算一遍状态、每次都把红点重新点亮的
 * 做法，等于把一个状态变成了永远关不掉的通知。
 *
 * 所以按「本机这一版 vs 中转机那一版」记账：同一对版本提示过一次就不再提示，本机重新构建或
 * 中转机换了一份（对比变了）才是新的一条。
 */

const NOTICE_NAME = 'page-notice.json';
const DATA_NAME = 'data.json';
/** 记多少条已看过的对比：够覆盖来回切几个构建，又不至于无限长。 */
const MAX_KEYS = 8;

export type PageNoticeState = { seen: string[] };

/** 一次对比的唯一键；两版都缺一不可（缺一边根本算不上「落后」）。 */
export function pageNoticeKey(local: string, remote: string): string {
  return local && remote ? `${local}->${remote}` : '';
}

export function readPageNotice(dir: string | null): PageNoticeState {
  if (!dir) return { seen: [] };
  try {
    const parsed = JSON.parse(readFileSync(join(dir, NOTICE_NAME), 'utf8')) as { seen?: unknown };
    const seen = Array.isArray(parsed?.seen)
      ? parsed.seen.filter((value): value is string => typeof value === 'string' && value.includes('->'))
      : [];
    return { seen: seen.slice(-MAX_KEYS) };
  } catch {
    // 文件不在或坏了：当成「都还没看过」。宁可多提示一次，也不要静默吞掉一次真需要做的事。
    return { seen: [] };
  }
}

/** 记下一条已看过的对比；已经记过就不动文件。 */
export function markPageNoticeSeen(dir: string | null, key: string): boolean {
  if (!dir || !key) return false;
  const state = readPageNotice(dir);
  if (state.seen.includes(key)) return false;
  try {
    writeFileSync(
      join(dir, NOTICE_NAME),
      `${JSON.stringify({ seen: [...state.seen, key].slice(-MAX_KEYS) }, null, 2)}\n`,
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

function readStatus(dir: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, DATA_NAME), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 用户点了与这条提示绑定的动作：这一对版本算看过了。
 *
 * 顺序有意义：先记账（下一次 `buildStatus` 就不会再算出 attention），再**就地把
 * `data.json` 里的 `attention` 抹掉**。常驻监管 3 秒才刷一次状态，等它刷的话，用户点完
 * 看到红点还在，只会以为「点了没用」。
 *
 * 返回被记下的 key（没有可记的对比时为空串）。
 */
export function acknowledgePageNotice(dir: string | null): string {
  if (!dir) return '';
  const status = readStatus(dir);
  const key = typeof status?.pageKey === 'string' ? status.pageKey : '';
  if (key) markPageNoticeSeen(dir, key);
  if (status && status.attention) {
    try {
      writeFileSync(join(dir, DATA_NAME), `${JSON.stringify({ ...status, attention: null }, null, 2)}\n`, 'utf8');
    } catch {
      // 写不进去也不要紧：常驻监管下一跳（3 秒内）会用新账本重算并覆盖。
    }
  }
  return key;
}
