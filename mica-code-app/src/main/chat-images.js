import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'

/**
 * Save the current clipboard image (if any) into the mica images directory
 * and return a `[Image](...)` ref that the mica CLI resolves on the next run.
 * `clipboard` is injected so tests can fake Electron's clipboard module.
 */
export function savePastedImage(clipboard) {
  let image
  try {
    image = clipboard.readImage()
  } catch {
    return { ok: false, error: '无法读取剪贴板图片' }
  }
  if (!image || image.isEmpty()) return { ok: false }

  const micaHome = process.env.MICA_HOME || join(homedir(), '.mica')
  const dir = join(micaHome, 'images')
  try {
    mkdirSync(dir, { recursive: true })
    const fileName = `image-${randomUUID()}.png`
    const filePath = join(dir, fileName)
    writeFileSync(filePath, image.toPNG())
    // The CLI resolves `~` against the real home; when MICA_HOME is set the
    // child process still resolves `~` the same way, so use the absolute path.
    const ref = process.env.MICA_HOME ? filePath : `~/.mica/images/${fileName}`
    return { ok: true, ref }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
