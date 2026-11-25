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

/**
 * 开关某个 webContents 的开发者工具。
 *
 * 停靠在当前窗口里（`mode: 'right'`）：不再弹独立窗口。必须显式给一个停靠位置——
 * 省略 `mode` 会用上次的停靠状态，上次是 `undocked` / `detach` 时又变成一个独立窗口。
 * 再按一次关掉。
 */
export function toggleDevTools(contents) {
  if (!contents || contents.isDestroyed()) return
  if (contents.isDevToolsOpened()) {
    contents.closeDevTools()
    return
  }
  contents.openDevTools({ mode: 'right' })
}

const attached = new WeakSet()

/**
 * 给一个 webContents 挂上 ⌥⌘I。主窗口、编辑器窗口、终端窗口、受控浏览器的每个标签页、
 * 插件浮窗里的网页视图都是各自独立的 webContents，`before-input-event` 也只发给持有焦点
 * 的那一个——所以按窗口逐个挂迟早漏一个，主进程统一在 `web-contents-created` 里挂。
 *
 * DevTools 自己的 webContents（`type: 'remote'`）跳过：它也会触发同一个事件，给它再开一层
 * 开发者工具没有意义。
 *
 * 返回解除函数；同一个 webContents 重复调用只挂一次（否则一次按键会开了又关）。
 */
export function attachDevToolsShortcut(contents, platform = process.platform) {
  if (!contents || typeof contents.on !== 'function') return () => {}
  if (typeof contents.isDestroyed === 'function' && contents.isDestroyed()) return () => {}
  if (typeof contents.getType === 'function' && contents.getType() === 'remote') return () => {}
  if (attached.has(contents)) return () => {}
  const onInput = (event, input) => {
    if (!isDevToolsShortcut(input, platform)) return
    event.preventDefault()
    toggleDevTools(contents)
  }
  attached.add(contents)
  contents.on('before-input-event', onInput)
  return () => {
    attached.delete(contents)
    if (typeof contents.removeListener === 'function') contents.removeListener('before-input-event', onInput)
  }
}
