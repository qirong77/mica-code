import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 剪贴板里的**文件**（Finder 里复制的文件夹、Excel、图片文件…）在页面这一侧拿不到路径：
 * Chromium 只把文件名交给 `ClipboardEvent`（`File.path` 从 Electron 32 起已删除，
 * `webUtils.getPathForFile` 又只对渲染进程可用，而本应用的页面没有 preload）。所以路径
 * 只能由运行时从**同一台机器**的系统剪贴板里读出来，再按文件名与粘贴事件里的条目对上。
 *
 * 这份实现因此分两层：纯解析函数（可在单测里直接喂剪贴板原文）+ 一次平台命令读取。
 * 远端浏览器粘贴时系统剪贴板属于用户那台机器，可能与运行时不同——所以匹配不上时必须有
 * 明确降级（见 renderer 的 composer-paste.js），不能凭猜测插一个别的文件的路径。
 */

/** 从 `NSFilenamesPboardType` 的 XML plist 里取路径（Finder 复制多个文件时是这种格式） */
export function parseFilenamesPlist(text) {
  if (!text || /^\s*bplist/.test(text)) return []
  const paths = []
  const re = /<string>([\s\S]*?)<\/string>/g
  let match
  while ((match = re.exec(text)) !== null) paths.push(decodeXmlEntities(match[1]))
  return paths.filter(Boolean)
}

function decodeXmlEntities(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

/** `file://` URL（单行或多行的 text/uri-list）→ 本地路径，非 file 协议一律忽略 */
export function fileUrlsToPaths(text) {
  if (!text) return []
  const paths = []
  for (const line of String(text).split(/\r?\n/)) {
    const value = line.trim()
    if (!value || value.startsWith('#') || !/^file:\/\//i.test(value)) continue
    try {
      paths.push(fileURLToPath(value))
    } catch {
      // 非法 URL（含 Windows 上盘符不合法的情况）直接跳过
    }
  }
  return paths
}

/** macOS 侧读到的原始片段 → 去重后的路径列表（保持剪贴板顺序） */
export function parseClipboardPayload({ list, plist, url, uriList } = {}) {
  const paths = []
  if (Array.isArray(list)) paths.push(...list.filter((item) => typeof item === 'string' && item))
  paths.push(...parseFilenamesPlist(plist))
  paths.push(...fileUrlsToPaths(url))
  paths.push(...fileUrlsToPaths(uriList))
  const seen = new Set()
  return paths.filter((item) => {
    if (seen.has(item)) return false
    seen.add(item)
    return true
  })
}

/**
 * 把剪贴板候选路径与粘贴事件里的文件名对上（按粘贴顺序返回）。
 * 只按 basename 比较：远端浏览器与运行时不是同一台机器时，这两份数据本来就互不相干，
 * 对不上就是「拿不到路径」，绝不能退回「随便挑一个」。
 */
export function matchPastedFilePaths(names, paths) {
  const pool = [...(paths || [])]
  const matched = []
  for (const name of names || []) {
    const target = String(name || '').toLowerCase()
    if (!target) continue
    const index = pool.findIndex((path) => basename(path).toLowerCase() === target)
    if (index >= 0) matched.push(pool.splice(index, 1)[0])
  }
  return matched
}

const MAC_SCRIPT = `ObjC.import("AppKit")
const board = $.NSPasteboard.generalPasteboard
function read(format) {
  try {
    const value = board.stringForType(format)
    return value && !value.isNil() ? ObjC.unwrap(value) : null
  } catch (error) {
    return null
  }
}
function readList(format) {
  try {
    const value = board.propertyListForType(format)
    if (!value || value.isNil()) return null
    const list = ObjC.unwrap(value)
    return Array.isArray(list) ? list.filter((item) => typeof item === "string") : null
  } catch (error) {
    return null
  }
}
JSON.stringify({
  list: readList("NSFilenamesPboardType"),
  plist: read("NSFilenamesPboardType"),
  url: read("public.file-url"),
  uriList: read("text/uri-list")
})`

const WINDOWS_SCRIPT =
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
  'Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }'

function run(command, args, timeout = 1500) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout, windowsHide: true, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        resolve(error ? null : String(stdout || ''))
      }
    )
  })
}

/**
 * 读系统剪贴板里的文件路径。拿不到（没有文件、平台命令不可用、超时）一律返回空数组——
 * 调用方据「空 = 降级」处理，不要把失败变成抛错。
 */
export async function readClipboardFilePaths(platform = process.platform) {
  try {
    if (platform === 'darwin') {
      const output = await run('osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT])
      if (!output) return []
      return parseClipboardPayload(JSON.parse(output))
    }
    if (platform === 'win32') {
      const output = await run('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        WINDOWS_SCRIPT
      ])
      return String(output || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    }
    if (platform === 'linux') {
      for (const [command, args] of [
        ['wl-paste', ['-t', 'text/uri-list']],
        ['xclip', ['-selection', 'clipboard', '-t', 'text/uri-list', '-o']]
      ]) {
        const output = await run(command, args)
        const paths = fileUrlsToPaths(output)
        if (paths.length) return paths
      }
    }
  } catch {
    // 解析失败也只是「没拿到」，不往上层抛
  }
  return []
}
