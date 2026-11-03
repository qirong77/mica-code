/**
 * 编辑器里的终端面板（`EditorTerminal.jsx`）的纯逻辑：快捷键判定、面板高度、标签标题、
 * 关闭前的确认文案。终端本体与界面不在这里。
 *
 * 面板的开关与高度和对话底部终端一样存在界面状态（`ui-state` 的 `editorTerminal`）里：
 * 第二个窗口读到的是同一份，重启后也还在。终端自己（PTY、标签）归页面，不共享——两个
 * 窗口各开各的 shell。
 */
import { setUiState, uiStateKeys } from './ui-state'

export const EDITOR_TERMINAL_KEY = 'editorTerminal'
export const DEFAULT_EDITOR_TERMINAL_HEIGHT = 280
export const MIN_EDITOR_TERMINAL_HEIGHT = 120
/** 最多占视高的 3/4：拖到哪算哪，但要给编辑器留一截。与对话底部终端同一条规矩。 */
const MAX_EDITOR_TERMINAL_HEIGHT_RATIO = 0.75

/**
 * Ctrl+` —— 对话底部终端与编辑器终端共用这一条。
 *
 * 只认 Ctrl：macOS 上 ⌘` 是系统「切换窗口」的保留键，会被先吞掉。
 */
export function isTerminalToggleShortcut(event) {
  return (
    !!event &&
    !event.repeat &&
    !event.metaKey &&
    event.ctrlKey === true &&
    !event.altKey &&
    !event.shiftKey &&
    event.code === 'Backquote'
  )
}

function viewportHeight() {
  return typeof window === 'undefined' ? 0 : Number(window.innerHeight) || 0
}

export function editorTerminalHeightLimit(viewport = viewportHeight()) {
  const height = Number(viewport)
  if (!Number.isFinite(height) || height <= 0) return Infinity
  return Math.max(MIN_EDITOR_TERMINAL_HEIGHT, Math.round(height * MAX_EDITOR_TERMINAL_HEIGHT_RATIO))
}

export function clampEditorTerminalHeight(value, viewport = viewportHeight()) {
  const height = Number(value)
  const base =
    Number.isFinite(height) && height > 0 ? Math.round(height) : DEFAULT_EDITOR_TERMINAL_HEIGHT
  return Math.min(Math.max(base, MIN_EDITOR_TERMINAL_HEIGHT), editorTerminalHeightLimit(viewport))
}

/** 面板此刻的开关与高度：缺省值、非法值都在这里收口，界面只按结果画。 */
export function readEditorTerminalState() {
  const value = uiStateKeys()[EDITOR_TERMINAL_KEY]
  const record = value && typeof value === 'object' ? value : {}
  return {
    open: record.open === true,
    height: clampEditorTerminalHeight(record.height)
  }
}

/** 只改传进来的那几项：另一个窗口刚写的开关 / 高度不会被这次写入抹掉。 */
export function writeEditorTerminalState(patch) {
  setUiState(EDITOR_TERMINAL_KEY, { ...readEditorTerminalState(), ...patch })
}

export function setEditorTerminalOpen(open) {
  writeEditorTerminalState({ open: open === true })
}

/** 返回切换后的状态：快捷键与顶栏按钮共用同一个入口。 */
export function toggleEditorTerminalOpen() {
  const next = !readEditorTerminalState().open
  setEditorTerminalOpen(next)
  return next
}

/** 路径末段（`/a/b/c/` → `c`），标签标题与窗口标题都用它。 */
export function folderNameOf(path) {
  const parts = String(path || '')
    .replaceAll('\\', '/')
    .replace(/\/+$/, '')
    .split('/')
  return parts[parts.length - 1] || ''
}

/**
 * 标签标题：优先用目录名（`mica-code`），同一个目录再开一个时加序号；没有目录
 * （还没选项目）时退回「终端 N」。同名的标签在标签条上没法分辨，所以不许重名。
 */
export function terminalTabTitle(tabs, cwd) {
  const taken = new Set((tabs || []).map((tab) => tab.title))
  const base = folderNameOf(cwd)
  if (base) {
    if (!taken.has(base)) return base
    let index = 2
    while (taken.has(`${base} (${index})`)) index += 1
    return `${base} (${index})`
  }
  let index = (tabs || []).length + 1
  while (taken.has(`终端 ${index}`)) index += 1
  return `终端 ${index}`
}

export function createEditorTerminalTab({ id, cwd, tabs = [] }) {
  return { id, cwd: cwd || null, title: terminalTabTitle(tabs, cwd) }
}

/** 关掉 `closedId` 之后该选谁：右边的接上来，没有就选左边。 */
export function activeTabAfterClose(tabs, closedId) {
  const list = tabs || []
  const index = list.findIndex((tab) => tab.id === closedId)
  if (index < 0) return null
  return list[index + 1]?.id || list[index - 1]?.id || null
}

/** `ps -o command=` 给的是整行命令（可能带完整路径、还可能有换行），压成一行再截断。 */
export function describeRunningCommand(command) {
  const line = String(command || '')
    .split('\n')[0]
    .replace(/\s+/g, ' ')
    .trim()
  if (!line) return ''
  // 只留命令名与第一个参数：`/opt/homebrew/bin/node …` 截一半的路径没有信息量
  const [bin, ...rest] = line.split(' ')
  const name = bin.split('/').pop() || bin
  const joined = [name, ...rest.slice(0, 2)].join(' ')
  return joined.length > 48 ? `${joined.slice(0, 47)}…` : joined
}

/** 「还在跑的是什么」：去重后最多列三条，其余折成「等」。 */
export function runningCommandsLabel(entries) {
  const names = []
  for (const entry of entries || []) {
    const name = describeRunningCommand(entry?.command)
    if (name && !names.includes(name)) names.push(name)
  }
  if (!names.length) return ''
  return names.length > 3 ? `${names.slice(0, 3).join('、')} 等` : names.join('、')
}

export function closeTabConfirmText(entry) {
  const label = runningCommandsLabel(entry ? [entry] : [])
  const title = entry?.title ? `「${entry.title}」` : '这个终端'
  return `${title}里还有程序在运行${label ? `（${label}）` : ''}。\n关闭后它会立刻停止，正在做的事也会中断。确定关闭吗？`
}

export function closeWindowConfirmText(entries) {
  const count = (entries || []).length
  const label = runningCommandsLabel(entries)
  const scope = count > 1 ? `${count} 个终端` : '终端'
  return `编辑器${scope}里还有程序在运行${label ? `（${label}）` : ''}。\n关闭窗口会把它们一起结束，确定关闭吗？`
}
