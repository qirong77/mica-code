import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeTagStore, type TagStore } from './tags.js';

/**
 * 标签的落盘：`$MICA_HOME/session-tags.json`。
 *
 * 为什么不是 `ctx.sessionState`：标签是**跨会话**的检索维度，按键是 sessionId，而
 * `sessionState` 只活在当前这一条会话里，存进去就没法列「挂着某个标签的会话」。
 *
 * 为什么不是 `ctx.settings`：插件设置只能存清单里声明的键、值一律是字符串，装不下
 * 会随使用增长的多对多映射。
 *
 * 读的时候按 mtime + size 判断要不要重新解析：标签每次渲染、每轮 prompt 都要读，
 * 每次都解析整个 JSON 是浪费。改完由本进程写回时顺手更新缓存。
 */
export type TagStoreFile = {
  readonly path: string;
  read(): TagStore;
  write(store: TagStore): void;
};

export function createTagStoreFile(path: string, onError?: (message: string) => void): TagStoreFile {
  const warn = onError ?? (() => undefined);
  let cached: TagStore | null = null;
  let cachedStamp = '';

  const read = (): TagStore => {
    let stamp = '';
    try {
      const stat = statSync(path);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      // 文件还不存在：空 store，但不要缓存空 stamp，否则第一次写入后这里会误判「没变」。
      cached = null;
      cachedStamp = '';
      return normalizeTagStore(undefined);
    }
    if (cached && stamp === cachedStamp) return cached;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      cached = normalizeTagStore(raw);
      cachedStamp = stamp;
      return cached;
    } catch (error) {
      // 手改坏了 / 写到一半断电：当作空 store 继续跑，别让标签把会话带崩。
      warn(`读取标签文件失败：${error instanceof Error ? error.message : String(error)}`);
      cached = null;
      cachedStamp = '';
      return normalizeTagStore(undefined);
    }
  };

  /** 先写临时文件再 rename：中途崩溃不会留下半份 JSON。 */
  const write = (store: TagStore): void => {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
    const stat = statSync(path);
    cached = store;
    cachedStamp = `${stat.mtimeMs}:${stat.size}`;
  };

  return { path, read, write };
}
