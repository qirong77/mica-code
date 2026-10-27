// 会话文件头部的轻量读取：只为了拿顶层字段时，不要整份 JSON.parse。
// 最大的一份会话实测 52MB，同步解析会把运行时主线程按住几百毫秒，期间所有
// IPC 都排队；而顶层 `cwd` 写在 `snapshot` 之前（偏移 200–300 字节）。
import { closeSync, openSync, readSync } from 'fs'

/** 头部读多少字节；够覆盖 version / revision / id / title / createdAt / cwd。 */
export const HEAD_BYTES = 8192

function readHead(file, bytes) {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.toString('utf8', 0, read)
  } finally {
    closeSync(fd)
  }
}

/**
 * 顶层 `cwd`；读不到返回 null，交给调用方回退到整份解析。
 *
 * 只认 `snapshot` 之前出现的那一个 —— `snapshot` 内部也可能带 cwd 字段，
 * 那是嵌套值，不能当成会话的工作目录。
 */
export function readTopLevelCwd(file, bytes = HEAD_BYTES) {
  let head
  try {
    head = readHead(file, bytes)
  } catch {
    return null
  }
  const cwdAt = head.indexOf('"cwd"')
  if (cwdAt < 0) return null
  const snapshotAt = head.indexOf('"snapshot"')
  if (snapshotAt >= 0 && snapshotAt < cwdAt) return null
  const match = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head.slice(cwdAt))
  if (!match) return null
  try {
    // 捕获到的内容已经是合法的 JSON 字符串内层，补上引号就能还原转义。
    const value = JSON.parse(`"${match[1]}"`)
    return typeof value === 'string' && value.trim() ? value.trim() : null
  } catch {
    return null
  }
}
