import { closeSync, openSync, readSync } from 'node:fs';

export const SESSION_HEAD_BYTES = 4096;

/**
 * 会话文件把顶层键写在 `snapshot` 之前，读文件头就够描述一条会话，
 * 不必 parse 一份可能几十 MB 的文件（图片、完整工具历史）。
 */
export function readSessionFileHead(path: string, bytes = SESSION_HEAD_BYTES): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore: closing a read handle is best-effort
      }
    }
  }
}

/**
 * 从文件头里抠一个字符串字段。取第一次出现：文件顺序保证顶层键与 `snapshot`
 * 的前几个键在插件状态之类嵌套结构之前。
 */
export function readHeadString(head: string, key: string): string | undefined {
  if (!head) return undefined;
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(head);
  if (!match) return undefined;
  const raw = match[1]!;
  if (!raw.includes('\\')) return raw;
  try {
    const parsed = JSON.parse(`"${raw}"`) as unknown;
    return typeof parsed === 'string' ? parsed : raw;
  } catch {
    return raw;
  }
}
