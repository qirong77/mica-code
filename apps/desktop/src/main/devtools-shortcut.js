/**
 * 开发者工具的快捷键（⌥⌘I / Ctrl+Alt+I）。
 *
 * 应用没有自己的菜单（`autoHideMenuBar` + 不设置 application menu），Electron 默认菜单里
 * 那条「Toggle Developer Tools」在打包版里靠不住，页面自己也没有入口；排查问题只能戴上
 * 显微镜开控制台。所以这里直接认键，生产包同样生效。
 *
 * 判定按物理键位 `code`，不看 `key`：macOS 上 ⌥ 是死键前缀，⌥I 打出来的是 `ˆ`，
 * `input.key` 拿不到 `i`。
 */
export function isDevToolsShortcut(input, platform = process.platform) {
  if (!input || input.type !== 'keyDown') return false
  // 按住不放只该切一次：连发会开一个又立刻关掉
  if (input.isAutoRepeat) return false
  const accelerator = platform === 'darwin' ? input.meta : input.control
  if (!accelerator || !input.alt || input.shift) return false
  const code = String(input.code || '').toLowerCase()
  if (code) return code === 'keyi'
  // 合成事件可能没有 code；此时按 key 判断，⌥ 让 key 变成生僻字符时认不出来是正常的
  const key = String(input.key || '')
  return key.toLowerCase() === 'i' || key === 'I'
}
