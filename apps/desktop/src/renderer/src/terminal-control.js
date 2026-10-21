/**
 * 顶栏终端控制图标要用的纯逻辑：哪些终端属于当前页签、图标标题/角标怎么拼。
 *
 * 终端由 Electron 主进程持有一条真实 PTY，经运行时的 `terminal-control:list` 与
 * `terminal:changed` 送过来（形状见 apps/desktop/src/host/terminal-control-core.js）。
 */

function ownerIds(node) {
  return new Set([node?.id, node?.sessionId].filter(Boolean).map((value) => String(value)))
}

function shortOwner(owner) {
  const value = String(owner || '')
  if (!value) return ''
  return value.length > 6 ? value.slice(-6) : value
}

export function nodeTerminals(terminals, node) {
  const list = Array.isArray(terminals) ? terminals : []
  const ids = ownerIds(node)
  return list.filter((item) => !item?.owner || ids.has(String(item.owner)))
}

export function isTerminalOwnedByNode(terminal, node) {
  const owner = String(terminal?.owner || '')
  if (!owner) return false
  return ownerIds(node).has(owner)
}

export function terminalStatusLabel(terminal) {
  if (!terminal) return ''
  if (terminal.running === false) return '已退出'
  return terminal.windowVisible ? '已显示' : '后台运行'
}

export function terminalIconTitle(terminal, node) {
  if (!terminal) return ''
  const parts = [terminal.label || '终端控制']
  if (terminal.cwd) parts.push(terminal.cwd)
  if (!isTerminalOwnedByNode(terminal, node)) {
    const owner = shortOwner(terminal.owner)
    parts.push(owner ? `归属 ${owner}` : '未归属')
  }
  parts.push(`${terminal.cols}×${terminal.rows}`)
  parts.push(terminalStatusLabel(terminal))
  parts.push(terminal.windowVisible ? '点击隐藏' : '点击显示')
  parts.push('右键关闭')
  return parts.filter(Boolean).join(' · ')
}

/** 多个终端时每个图标标个序号，和浏览器图标一致 */
export function terminalIconBadge(terminals, terminal) {
  const list = Array.isArray(terminals) ? terminals : []
  if (list.length < 2) return ''
  const index = list.findIndex((item) => item?.id === terminal?.id)
  return index >= 0 ? String(index + 1) : ''
}
