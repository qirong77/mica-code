import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { ConfigWebSessionOption } from '../shared/types.js';

/** 只读文件头这么多字节：标题、cwd、模型、状态都出现在会话 JSON 的最前面。 */
const HEAD_BYTES = 8192;

type SessionHead = {
  title?: string;
  cwd?: string;
  model?: string;
  turnState?: string;
};

/**
 * 从会话文件头部抠出列表要用的字段。
 *
 * 会话快照动辄几 MB，列表页有上千个文件，整份解析会让配置页每次刷新都卡住好几秒
 * （`session-index.json` 的 rejects 就是为这件事存在的）。这里只读文件头的一个固定窗口，
 * 用正则取几个短字符串字段；读不出来的字段留空，调用方按「信息不全」展示。
 */
export function readSessionHead(path: string): SessionHead {
  const buffer = Buffer.allocUnsafe(HEAD_BYTES);
  const handle = openSync(path, 'r');
  let text: string;
  try {
    const length = readSync(handle, buffer, 0, buffer.length, 0);
    text = buffer.toString('utf-8', 0, length);
  } finally {
    closeSync(handle);
  }

  return {
    title: readString(text, 'title'),
    cwd: readString(text, 'cwd'),
    turnState: readString(text, 'turnState'),
    // 模型只在 `snapshot` 里读：usage 记录里也有 model，那属于某一次请求。
    model: readString(afterSnapshot(text), 'model'),
  };
}

function afterSnapshot(text: string): string {
  const at = text.indexOf('"snapshot"');
  return at >= 0 ? text.slice(at) : text;
}

/**
 * 列表行：标题、工作目录、模型、状态、文件大小。
 *
 * 标题之外的信息都从磁盘现读——列表要靠它们区分同名会话（「修 bug」可能同时有三条）。
 */
export function summarizeSessionFile(path: string, id: string): ConfigWebSessionOption {
  const head = readSessionHead(path);
  const stat = statSync(path);
  return {
    id,
    title: head.title?.trim() || id,
    updatedAt: stat.mtime.toISOString(),
    cwd: head.cwd,
    model: head.model,
    turnState: head.turnState,
    sizeBytes: stat.size,
  };
}

/** 取第一个匹配。 */
function readString(text: string, key: string): string | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`).exec(text);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return undefined;
  }
}
