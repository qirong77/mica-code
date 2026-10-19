import { ipcMain } from 'electron'
import { matchPastedFilePaths, readClipboardFilePaths } from './clipboard-files'

/**
 * 粘贴文件（文件夹 / Excel / 图片文件…）时把剪贴板里的**路径**交回页面：页面只有文件名，
 * 路径只能由运行时从系统剪贴板读出（见 clipboard-files.js 的说明）。`names` 是粘贴事件里
 * 的文件名，用来确认这份剪贴板就是用户刚粘贴的那一份；对不上就返回空，由页面降级提示。
 */
export function registerClipboardIpc() {
  ipcMain.handle('clipboard:file-paths', async (_event, { names } = {}) => {
    const paths = await readClipboardFilePaths()
    if (!paths.length) return { paths: [] }
    const wanted = Array.isArray(names) ? names : null
    return { paths: wanted ? matchPastedFilePaths(wanted, paths) : paths }
  })
}
