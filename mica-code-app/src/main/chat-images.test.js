import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { savePastedImage } from './chat-images'

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
})
