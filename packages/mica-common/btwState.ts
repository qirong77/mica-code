import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveMicaHomePath } from '@packages/mica-config/brand.js';

/**
 * By The Way（btw）线程的落盘。
 *
 * 为什么放在 `mica-common` 而不是桌面端或 app-server 里：写入方是常驻 host
 * （`apps/cli/src/runtime/btwThread.ts` 的 `BtwThreads`），清理由 `SessionStore.delete`
 * 触发，两边分属不同包——路径与读写只有一份，才不会一边叫 `btw/` 另一边叫 `btw-threads/`。
 *
 * 为什么不在 `sessions/` 里：那个目录会被会话扫描、会话索引与 config-web 的会话列表当成
 * 会话文件解析，混进另一种 JSON 只会让它们各多一堆防御。这里一个会话一个文件，
 * 文件名就是会话 id，所以「删掉会话」顺手就能删掉它的 btw 线程。
 */

/** 一条落盘的 btw 线程（与 `MicaBtwStoredThread` 同形状，这里不依赖 runtime 包）。 */
export type StoredBtwThread = {
  id: string;
  entries: unknown[];
  /**
   * 子代理的消息数组——重启后还能「接着追问」靠的就是它。
   *
   * 媒体块（图片/文档）在写入前已被丢弃：base64 能让文件涨到几十 MB，而重启后那段
   * 上下文本来也不再需要图本身。
   */
  messages: unknown[];
};

export const BTW_STATE_VERSION = 1;

/** 会话 id 会直接拼进文件名：带分隔符或 `..` 的一律不接受（宁可当成没有）。 */
export function isValidBtwSessionId(sessionId: string): boolean {
  if (!sessionId) return false;
  return !sessionId.includes('/') && !sessionId.includes('\\') && !sessionId.includes('..');
}

export function btwStatePath(sessionId: string): string | null {
  if (!isValidBtwSessionId(sessionId)) return null;
  return resolveMicaHomePath('btw', `${sessionId}.json`);
}

/** 读一个会话的 btw 线程；文件不存在、坏掉、版本不认识都当成「没有」。 */
export function readBtwState(sessionId: string): StoredBtwThread[] {
  const path = btwStatePath(sessionId);
  if (!path) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      version?: number;
      threads?: unknown;
    };
    if (!parsed || parsed.version !== BTW_STATE_VERSION || !Array.isArray(parsed.threads)) return [];
    // 空线程（没有任何问答）不返回：它只是界面上一个还没提问的 tab，不是可恢复的内容。
    return parsed.threads.filter(
      (item): item is StoredBtwThread => isStoredThread(item) && item.entries.length > 0,
    );
  } catch {
    return [];
  }
}

/** 整份覆盖写；空数组等于删掉这个文件（免得留下一堆空壳）。 */
export function writeBtwState(sessionId: string, threads: StoredBtwThread[]): void {
  const path = btwStatePath(sessionId);
  if (!path) return;
  if (threads.length === 0) {
    deleteBtwState(sessionId);
    return;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    // 先写临时文件再 rename：否则崩在写一半会留下半截 JSON，下次读回来整份丢掉。
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: BTW_STATE_VERSION, sessionId, threads }), 'utf8');
    renameSync(temp, path);
  } catch {
    // 存不下来不影响问答（btw 是辅助能力）。
  }
}

/** 删掉一个会话的 btw 线程（`SessionStore.delete` 与「清空线程」都走它）。 */
export function deleteBtwState(sessionId: string): void {
  const path = btwStatePath(sessionId);
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort
  }
}

function isStoredThread(value: unknown): value is StoredBtwThread {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && record.id.length > 0 && Array.isArray(record.entries);
}
