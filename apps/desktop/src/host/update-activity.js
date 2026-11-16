import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPidAlive } from './session-lease.js'

/** Only used by the explicit install preflight, never by footer polling or memory sampling. */
export function countUpdateLeases(directory, isAlive = isPidAlive) {
  let names
  try {
    names = readdirSync(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
  let count = 0
  for (const name of names) {
    if (!name.endsWith('.lock')) continue
    let owner
    try {
      owner = JSON.parse(readFileSync(join(directory, name), 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') continue // Owner finished between readdir and read.
      throw new Error('会话锁正在写入或无法读取，请稍后重试')
    }
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0) throw new Error('无法确认会话锁的持有进程')
    if (isAlive(owner.pid)) count += 1
  }
  return count
}

/** Validate snapshots before trusting them: a missing field must never mean idle. */
export function updateActivityBlockers(activity) {
  const kinds = [
    ['chats', '个会话或后台任务仍在运行'],
    ['commits', '个提交任务仍在运行'],
    ['terminals', '个终端仍打开，请先退出或关闭'],
    ['browsers', '个受控浏览器窗口仍打开，请先关闭'],
    ['editors', '个独立编辑器窗口仍打开，请保存并关闭'],
    ['unsaved', '个窗口有未保存或正在保存的文件']
  ]
  if (activity?.ok !== true) throw new Error('工作状态返回不完整')
  return kinds.flatMap(([kind, label]) => {
    const count = activity[kind]
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`工作状态缺少 ${kind}`)
    return count ? [{ kind, count, label: `有 ${count} ${label}` }] : []
  })
}
