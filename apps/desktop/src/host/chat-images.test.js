import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { saveUploadedImage, savePastedImage } from './chat-images'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01])

function fakeClipboard({ empty = false, png = Buffer.from('fake-png') } = {}) {
  return {
    readImage: () => ({
      isEmpty: () => empty,
      toPNG: () => png
    })
  }
}

describe('savePastedImage', () => {
  let tempHome
  let previousHome

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'mica-chat-images-'))
    previousHome = process.env.MICA_HOME
    process.env.MICA_HOME = tempHome
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.MICA_HOME
    else process.env.MICA_HOME = previousHome
    rmSync(tempHome, { recursive: true, force: true })
  })

  it('returns ok:false when the clipboard has no image', () => {
    expect(savePastedImage(fakeClipboard({ empty: true }))).toEqual({ ok: false })
  })

  it('writes the image into $MICA_HOME/images and returns an absolute ref', () => {
    const result = savePastedImage(fakeClipboard({ png: Buffer.from('png-bytes') }))
    expect(result.ok).toBe(true)
    expect(result.ref.startsWith(tempHome)).toBe(true)
    expect(result.ref).toMatch(/image-[0-9a-f-]+\.png$/)
    expect(existsSync(result.ref)).toBe(true)
    expect(readFileSync(result.ref)).toEqual(Buffer.from('png-bytes'))
  })

  describe('saveUploadedImage', () => {
    it('keeps the extension of the declared media type', () => {
      const jpeg = saveUploadedImage(JPEG, 'image/jpeg')
      expect(jpeg.ok).toBe(true)
      expect(jpeg.ref).toMatch(/\.jpg$/)
      expect(readFileSync(jpeg.ref)).toEqual(JPEG)

      const png = saveUploadedImage(PNG, 'image/png')
      expect(png.ref).toMatch(/\.png$/)
    })

    it('falls back to magic bytes when the media type is not one the CLI reads', () => {
      const result = saveUploadedImage(JPEG, 'image/heic')
      expect(result.ok).toBe(true)
      expect(result.ref).toMatch(/\.jpg$/)
    })

    it('rejects data that is not a supported image', () => {
      expect(saveUploadedImage(Buffer.alloc(0))).toEqual({ ok: false, error: '缺少图片数据' })
      expect(saveUploadedImage(Buffer.from('<svg/>'), 'image/svg+xml')).toMatchObject({
        ok: false
      })
      expect(saveUploadedImage(Buffer.alloc(0), 'image/png')).toMatchObject({ ok: false })
      const dir = join(tempHome, 'images')
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
    })
  })
})
