/**
 * 输入框的粘贴：图片、文件（文件夹 / Excel / 任意文件）都落到草稿文本里。
 *
 * - 图片（截图、复制的图片数据）→ 存进 mica 的 images 目录，插入 `[Image](路径)`；
 * - 文件 → 插入它的**绝对路径**。路径只有运行时读得到（Chromium 不给页面文件路径，
 *   见 host/clipboard-files.js），所以按粘贴事件里的文件名与剪贴板路径对齐；对不上时
 *   明确提示，绝不插一个来路不明的路径。
 *
 * 主对话输入条与 By The Way 抽屉共用这一份：两处粘贴的行为必须一致。
 */

function pastedFiles(event) {
  const data = event.clipboardData
  if (!data) return { data, files: [], imageItems: [] }
  return {
    data,
    files: Array.from(data.files ?? []),
    imageItems: Array.from(data.items ?? []).filter((item) => item.type.startsWith('image/'))
  }
}

/**
 * 这份粘贴是「复制了文件」（而不是截图/复制的图片数据）吗？
 * 文件复制拿到的 `File` 没有内容（size 0），图片数据则有真实字节。
 */
export function isFileCopyPaste(files) {
  return (files || []).some((file) => !file.size || !String(file.type || '').startsWith('image/'))
}

async function clipboardPaths(files) {
  const api = window.mica?.clipboard
  if (!api?.filePaths) return []
  try {
    const result = await api.filePaths(files.map((file) => file.name).filter(Boolean))
    return Array.isArray(result?.paths) ? result.paths : []
  } catch {
    return []
  }
}

async function insertClipboardImage(event, data, imageItems, insertText) {
  // Electron 主进程直接读系统剪贴板；浏览器只能拿到粘贴事件里的文件
  const file = imageItems[0]?.getAsFile?.() || null
  const fallback = data.getData?.('text/plain') ?? ''
  try {
    const result = await window.mica.chat.savePastedImage(window.mica.isWeb ? { file } : undefined)
    insertText(result?.ok ? `[Image](${result.ref})` : fallback)
  } catch {
    // 存不下来就不插半截引用，草稿保持原样
  }
}

/**
 * 处理一次 paste 事件；返回是否已经接管（false 表示交给浏览器默认粘贴）。
 * `insertText` 决定插到哪儿（主输入条与抽屉各自的光标逻辑），`notify` 报失败原因。
 */
export async function pasteIntoComposer(event, { insertText, notify } = {}) {
  const { data, files, imageItems } = pastedFiles(event)
  if (!files.length && !imageItems.length) return false
  event.preventDefault()

  if (isFileCopyPaste(files)) {
    const paths = await clipboardPaths(files)
    if (paths.length) {
      insertText?.(paths.join(' '))
      return true
    }
    // 文件路径拿不到时，图片文件还能按图片处理；其余（文件夹、Excel…）只能提示
    if (!imageItems.length) {
      notify?.('无法读取剪贴板里的文件路径，请手动输入路径', 'error')
      return true
    }
  }

  if (imageItems.length) await insertClipboardImage(event, data, imageItems, insertText)
  return true
}
