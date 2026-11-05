import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SESSION_DIR } from './sessionStore.js';

/**
 * 每条会话「本轮写过哪些文件」的台账。
 *
 * 存在的理由只有一个：工作区里的未提交改动没有作者。`git status` / `git diff` 只
 * 告诉你哪些文件变了，不告诉你是谁改的——多个 Mica 会话同时开在同一个工作目录时，
 * 主会话只能靠猜，猜错就会把别的会话的改动当成自己的子代理越界，进而整文件还原。
 *
 * 台账与 turn 锁放在同一层（`sessions/.turn-locks/<id>.writes`），因为它描述的就是
 * 「这个正在跑的 turn 动过什么」，随租约一起被读到、一起过期。只记工具写过的路径，
 * 不解析内容；`run_shell` 里的重定向看不见，所以它只是**证据之一**，不是绝对真相。
 */
export type SessionWriteRecord = {
  /** 写入时的绝对路径。 */
  path: string;
  /** 写入时间（ISO）。 */
  at: string;
};

export type ReadSessionWritesOptions = {
  sessionDir?: string;
  /** 只要这个时刻之后的记录；传 0 表示全要。 */
  since?: number | Date;
  /** 最多返回多少条（保留最新的），默认 200。 */
  limit?: number;
};

export type RecordSessionWriteOptions = {
  sessionDir?: string;
  at?: Date;
};

/** 台账按行追加，超过这个体量就压掉旧行——它只服务「刚才谁改了这个文件」。 */
const MAX_LEDGER_BYTES = 128 * 1024;
const KEEP_LINES_ON_COMPACT = 200;

export function sessionWritesPath(sessionId: string, sessionDir = SESSION_DIR): string {
  return resolve(sessionDir, '.turn-locks', `${sessionId}.writes`);
}

/** 记一条（或多条）写入。失败一律吞掉：归因是辅助信息，不该让工具调用跟着报错。 */
export function recordSessionWrite(
  sessionId: string,
  paths: string[],
  options: RecordSessionWriteOptions = {},
): void {
  const unique = [...new Set(paths.filter((path) => typeof path === 'string' && path.length > 0))];
  if (!sessionId || unique.length === 0) return;
  const path = sessionWritesPath(sessionId, options.sessionDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    compactIfOversized(path);
    const stamp = (options.at ?? new Date()).toISOString();
    appendFileSync(path, unique.map((item) => `${JSON.stringify({ path: item, at: stamp })}\n`).join(''), 'utf8');
  } catch {
    // 台账是辅助信息，写不进去就算了。
  }
}

export function readSessionWrites(sessionId: string, options: ReadSessionWritesOptions = {}): SessionWriteRecord[] {
  if (!sessionId) return [];
  const path = sessionWritesPath(sessionId, options.sessionDir);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const since = options.since === undefined ? 0 : new Date(options.since).getTime();
  const limit = options.limit ?? 200;
  const records: SessionWriteRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Partial<SessionWriteRecord>;
      if (typeof parsed.path !== 'string' || typeof parsed.at !== 'string') continue;
      const time = Date.parse(parsed.at);
      if (Number.isFinite(since) && since > 0 && !(time >= since)) continue;
      records.push({ path: parsed.path, at: parsed.at });
    } catch {
      // 半行（进程被杀在追加中间）跳过，不让一条坏行毁掉整份台账。
    }
  }
  return records.length > limit ? records.slice(records.length - limit) : records;
}

function compactIfOversized(path: string): void {
  try {
    if (statSync(path).size <= MAX_LEDGER_BYTES) return;
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    writeFileSync(path, `${lines.slice(-KEEP_LINES_ON_COMPACT).join('\n')}\n`, 'utf8');
  } catch {
    // 没有文件、读不到都走这里：下一次 append 会自己建。
  }
}
