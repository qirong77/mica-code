import { mkdirSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'

/**
 * 把「添加附件」选中的文件落盘到 `$MICA_HOME/attachments/`，返回绝对路径。
 *
 * 页面没有 preload，浏览器给的 `File` 上拿不到真实路径（Electron 32 之后也没有
 * `File.path`），所以附件只能上传一份副本再插进输入框。副本落在 mica 自己的目录里，
 * 模型读到的就是这份路径——与粘贴图片的 `[Image](...)` 走同一条思路。
 */
export function saveAttachmentBytes(bytes, name = 'file') {
  const micaHome = process.env.MICA_HOME || join(homedir(), '.mica')
  const dir = join(micaHome, 'attachments')
  const safeName = sanitizeFileName(name)
  try {
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, `${randomUUID()}-${safeName}`)
    writeFileSync(filePath, bytes)
    return { ok: true, path: filePath, name: safeName }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 只留文件名本体：去掉分隔符、控制字符与开头的点，长度封顶 120。 */
export function sanitizeFileName(name) {
  const base = basename(String(name || 'file'))
  const cleaned = Array.from(base)
    .map((char) => (/[/\\:*?"<>|]/.test(char) || char.charCodeAt(0) < 32 ? '_' : char))
    .join('')
    .replace(/^\.+/, '')
    .trim()
  const bounded = cleaned.slice(0, 120)
  return bounded || 'file'
}

/** `data:<mime>;base64,...` → 字节。附件不校验具体类型，只要求声明了 base64。 */
export function decodeDataUrl(dataUrl) {
  const match = /^data:[^;,]*;base64,/i.exec(String(dataUrl || ''))
  if (!match) return null
  const bytes = Buffer.from(String(dataUrl).slice(match[0].length), 'base64')
  return bytes.length ? bytes : null
}
