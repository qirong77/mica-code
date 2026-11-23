import { ipcMain } from 'electron'
import { statSync } from 'fs'
// 只取这个窄模块：投影的读写与路径规则都在 `mica-tools` 里，宿主别再抄一份文件名。
import { readToolIconCatalog, toolIconCatalogPath } from '@packages/mica-tools/toolIconCatalog.js'

/**
 * 工具行图标的来源：`$MICA_HOME/tool-icons.json`（跑 agent 的宿主写下的注册表投影）。
 *
 * emoji 是工具自己的声明——内置工具在类里写 `icon`，插件在
 * `ctx.tools.register(tool, { icon })` 里给。那份注册表活在 app-server 进程，页面拿不到；
 * 而页面要画的还不只是正在进行的一轮：没有启动会话的历史消息里也有插件工具。所以装配过
 * 插件的宿主把注册表投影成这份文件，页面按名字查，查不到的才回落到默认齿轮。
 *
 * 页面里没有第二张表：抄一份进渲染层就会漂移，插件工具行永远显示默认图标。
 */

/** 按 mtime + 大小缓存：页面每轮开始都会问一次，读盘只发生在文件真的变过之后。 */
let cached = { key: '', icons: {} }

function readIcons() {
  const path = toolIconCatalogPath()
  let key
  try {
    const info = statSync(path)
    key = `${path}:${info.mtimeMs}:${info.size}`
  } catch {
    // 还没跑过装配插件的宿主（或用户刚清过 $MICA_HOME）：页面回落默认图标即可。
    cached = { key: '', icons: {} }
    return cached.icons
  }
  if (cached.key === key) return cached.icons
  cached = { key, icons: readToolIconCatalog() }
  return cached.icons
}

export function registerToolIconIpc() {
  ipcMain.handle('chat:tool-icons', () => readIcons())
}
