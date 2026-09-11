/**
 * 移动端终端功能键。
 *
 * 软键盘上没有 Esc / Tab / Ctrl / 方向键，shell 的补全、中断、翻历史在手机上等于
 * 全都用不了；桌面端那套修饰键映射（TerminalHost.jsx 的 interceptTerminalKey）
 * 只认物理键盘，触屏够不着。键栏把这几类按键补成可点按的按钮，序列沿用同一套约定。
 *
 * 排在前面的都是高频操作（中断、补全、历史），后面的符号键是手机上要切两三次
 * 键盘布局才能打出来的，一起放进来省事。键栏横向可滚动，加键不影响前几个。
 */
export const TERMINAL_KEYS = [
  { id: 'esc', label: 'Esc', title: 'Esc', data: '\x1b' },
  { id: 'tab', label: 'Tab', title: 'Tab 补全', data: '\t' },
  { id: 'ctrl-c', label: '^C', title: 'Ctrl+C 中断当前命令', data: '\x03' },
  { id: 'ctrl-d', label: '^D', title: 'Ctrl+D 结束输入 / 退出', data: '\x04' },
  { id: 'ctrl-z', label: '^Z', title: 'Ctrl+Z 挂起', data: '\x1a' },
  { id: 'ctrl-l', label: '^L', title: 'Ctrl+L 清屏', data: '\x0c' },
  { id: 'up', label: '↑', title: '上一条命令', data: '\x1b[A' },
  { id: 'down', label: '↓', title: '下一条命令', data: '\x1b[B' },
  { id: 'left', label: '←', title: '光标左移', data: '\x1b[D' },
  { id: 'right', label: '→', title: '光标右移', data: '\x1b[C' },
  { id: 'ctrl-a', label: '^A', title: 'Ctrl+A 光标到行首', data: '\x01' },
  { id: 'ctrl-e', label: '^E', title: 'Ctrl+E 光标到行尾', data: '\x05' },
  { id: 'ctrl-u', label: '^U', title: 'Ctrl+U 清空当前行', data: '\x15' },
  { id: 'pipe', label: '|', title: '管道', data: '|' },
  { id: 'dash', label: '-', title: '短横线', data: '-' },
  { id: 'slash', label: '/', title: '斜杠', data: '/' },
  { id: 'tilde', label: '~', title: '波浪线', data: '~' }
]

/**
 * 软键盘上 xterm 会丢掉的按键：返回应当补发的字符，不需要补发时返回 null。
 *
 * xterm 6 的 `_inputEvent` 只接受满足 `!e.composed || !_keyDownSeen` 的 input 事件，
 * 而浏览器派发的 input 事件 `composed` 恒为 true、keydown → input 之间
 * `_keyDownSeen` 又恒为 true ——「keydown 之后到达的 input」一律被丢弃。软键盘恰好
 * 只剩这条路：空格在 xterm 的键盘求值里拿不到 key（keyCode 32 < 48），`_keyDown`
 * 直接 return，既不发数据也不 preventDefault，字符落进隐藏 textarea 后本该由 input
 * 兜底 —— 结果被上面那条守卫丢掉。桌面端还有 keypress 接住，移动端浏览器根本不派发
 * keypress，于是空格就彻底没了；A–Z 同理（xterm 对它们提前 return，等一个永远等不到
 * 的 keypress）。
 *
 * 调用方必须自己 `preventDefault()`：不拦下默认行为，浏览器仍会把字符写进隐藏
 * textarea；桌面端还会让 keypress 再发一次。keyCode 229 / 0 必须放行 —— 那是 Android
 * IME 的组合态 keydown，要留给 xterm 自己的 textarea diff 逻辑。
 */
export function softKeyboardFallbackKey(event) {
  if (!event || event.type !== 'keydown') return null
  // 229（组合中）/ 0（Unidentified）：xterm 的 CompositionHelper 负责
  if (event.keyCode === 229 || event.keyCode === 0) return null
  if (event.ctrlKey || event.altKey || event.metaKey) return null
  if (event.key === ' ') return ' '
  if (event.key && event.key.length === 1 && event.key >= 'A' && event.key <= 'Z') {
    return event.key
  }
  return null
}

/**
 * 读系统剪贴板，读不到返回 null。
 *
 * 局域网访问走 http，不是 secure context，`navigator.clipboard` 压根不存在；
 * 用户拒绝授权时 `readText()` 会 reject。两种情况都返回 null，由调用方提示改从
 * 系统键盘粘贴，不要静默什么都不发生。
 */
export async function readClipboardText() {
  try {
    const text = await globalThis.navigator?.clipboard?.readText?.()
    return typeof text === 'string' && text.length > 0 ? text : null
  } catch {
    return null
  }
}
