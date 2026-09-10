import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'

/**
 * 把一张 PNG 写入 mica 的 images 目录，返回 `[Image](...)` 引用，
 * 供 mica CLI 在下一次运行时解析。
 *
 * 引用格式（`~/...` 或 MICA_HOME 下的绝对路径）是 CLI 的解析约定，改动会破坏附件链路。
 */
export function saveImagePng(png) {
  const micaHome = process.env.MICA_HOME || join(homedir(), '.mica')
  const dir = join(micaHome, 'images')
  try {
    mkdirSync(dir, { recursive: true })
    const fileName = `image-${randomUUID()}.png`
    const filePath = join(dir, fileName)
    writeFileSync(filePath, png)
    // The CLI resolves `~` against the real home; when MICA_HOME is set the
    // child process still resolves `~` the same way, so use the absolute path.
    const ref = process.env.MICA_HOME ? filePath : `~/.mica/images/${fileName}`
    return { ok: true, ref }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 保存当前系统剪贴板里的图片（Electron 主进程路径）。
 * `clipboard` 由调用方注入，便于测试替换 Electron 的 clipboard 模块。
 */
export function savePastedImage(clipboard) {
  let image
  try {
    image = clipboard.readImage()
  } catch {
    return { ok: false, error: '无法读取剪贴板图片' }
  }
  if (!image || image.isEmpty()) return { ok: false }
  return saveImagePng(image.toPNG())
}
