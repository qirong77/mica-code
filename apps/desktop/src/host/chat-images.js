import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'

/**
 * 把图片字节写入 mica 的 images 目录，返回 `[Image](...)` 引用，
 * 供 mica CLI 在下一次运行时解析。
 *
 * 引用格式（`~/...` 或 MICA_HOME 下的绝对路径）是 CLI 的解析约定，改动会破坏附件链路。
 */
export function saveImageBytes(bytes, extension = 'png') {
  const micaHome = process.env.MICA_HOME || join(homedir(), '.mica')
  const dir = join(micaHome, 'images')
  try {
    mkdirSync(dir, { recursive: true })
    const fileName = `image-${randomUUID()}.${extension}`
    const filePath = join(dir, fileName)
    writeFileSync(filePath, bytes)
    // The CLI resolves `~` against the real home; when MICA_HOME is set the
    // child process still resolves `~` the same way, so use the absolute path.
    const ref = process.env.MICA_HOME ? filePath : `~/.mica/images/${fileName}`
    return { ok: true, ref }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function saveImagePng(png) {
  return saveImageBytes(png, 'png')
}

// CLI 只认这几种扩展名（packages/mica-ui/utils/imagePaste.ts），写错扩展名会让
// 附件在解析时被判成不支持的格式。
const EXTENSION_BY_MEDIA_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

/** 按 magic bytes 判断真实格式（浏览器给的 media type 不可靠时兜底） */
function sniffExtension(bytes) {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes.length >= 6 && bytes.subarray(0, 3).toString('ascii') === 'GIF') return 'gif'
  if (bytes.length >= 12 && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  return null
}

/**
 * 落盘网页端上传的原始图片字节。
 * 扩展名以浏览器声明的类型为准，声明未知时按 magic bytes 兜底，
 * 两者都不认才拒绝——浏览器给的是原始字节，不能一律当 PNG 存。
 */
export function saveUploadedImage(bytes, mediaType = '') {
  if (!bytes?.length) return { ok: false, error: '缺少图片数据' }
  const extension =
    EXTENSION_BY_MEDIA_TYPE[String(mediaType).toLowerCase()] || sniffExtension(bytes)
  if (!extension)
    return {
      ok: false,
      code: 'unsupported_image',
      error: `不支持的图片格式：${mediaType || '未知'}，请使用 PNG、JPEG、WebP 或 GIF`
    }
  return saveImageBytes(bytes, extension)
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
