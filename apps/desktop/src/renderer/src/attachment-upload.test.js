import { afterEach, describe, expect, it } from 'bun:test'
import { uploadAttachment } from './attachment-upload.js'

const originalFetch = globalThis.fetch
const CHUNK = 512 * 1024
const reply = (body, status = 200) => ({ ok: status === 200, status, json: async () => body })
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('binary attachment upload', () => {
  it('sends a multi-megabyte image in bounded concurrent requests and only reports acknowledged bytes', async () => {
    const file = new File([new Uint8Array(CHUNK * 5 + 17).fill(77)], 'photo.jpg', {
      type: 'image/jpeg'
    })
    const chunks = new Map()
    const progress = []
    let active = 0
    let peak = 0
    globalThis.fetch = async (url, options) => {
      if (url === '/api/uploads') {
        expect(JSON.parse(options.body)).toEqual({
          name: 'photo.jpg',
          type: 'image/jpeg',
          size: file.size,
          kind: 'image'
        })
        return reply({ ok: true, id: 'upload-1', chunkSize: CHUNK })
      }
      if (options.method === 'PUT') {
        expect(options.body.size).toBeLessThanOrEqual(CHUNK)
        expect(options.headers['content-type']).toBe('application/octet-stream')
        active += 1
        peak = Math.max(peak, active)
        const bytes = await options.body.arrayBuffer()
        chunks.set(
          Number(new URL(url, 'http://test').searchParams.get('offset')),
          Buffer.from(bytes)
        )
        active -= 1
        return reply({ ok: true })
      }
      expect(url).toBe('/api/uploads/upload-1/complete')
      expect(chunks.size).toBe(6)
      return reply({ ok: true, ref: '/images/photo.jpg' })
    }
    expect(
      await uploadAttachment(file, { kind: 'image', onProgress: (value) => progress.push(value) })
    ).toEqual({ ok: true, ref: '/images/photo.jpg' })
    const reconstructed = Buffer.concat(
      [...chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, bytes]) => bytes)
    )
    expect(reconstructed).toEqual(Buffer.from(await file.arrayBuffer()))
    expect(peak).toBe(3)
    expect(progress[0].loaded).toBe(0)
    expect(progress.at(-1)).toEqual({ loaded: file.size, total: file.size, phase: 'done' })
    expect(progress.map((value) => value.loaded)).toEqual(
      progress.map((value) => value.loaded).sort((a, b) => a - b)
    )
  })

  it('retries a lost chunk response without restarting the upload or double counting progress', async () => {
    let puts = 0
    let starts = 0
    let completes = 0
    const progress = []
    globalThis.fetch = async (url, options) => {
      if (url === '/api/uploads') {
        starts += 1
        return reply({ ok: true, id: 'retry-1', chunkSize: CHUNK })
      }
      if (options.method === 'PUT') {
        if (++puts === 1) throw new TypeError('connection reset after server accepted chunk')
        return reply({ ok: true })
      }
      if (++completes === 1) throw new TypeError('lost complete response')
      return reply({ ok: true, path: '/attachments/file.txt' })
    }
    await uploadAttachment(new File(['hello'], 'file.txt'), {
      onProgress: (value) => progress.push(value)
    })
    expect(starts).toBe(1)
    expect(puts).toBe(2)
    expect(completes).toBe(2)
    expect(
      progress.filter((value) => value.phase === 'uploading' && value.loaded === 5)
    ).toHaveLength(1)
  })

  it('explains proxy HTML errors and cancels the staged upload without retrying 413', async () => {
    const methods = []
    globalThis.fetch = async (url, options) => {
      methods.push(options.method)
      if (url === '/api/uploads') return reply({ ok: true, id: 'failed-1', chunkSize: CHUNK })
      if (options.method === 'DELETE') return reply({ ok: true })
      return {
        ok: false,
        status: 413,
        json: async () => {
          throw new SyntaxError('<html>')
        }
      }
    }
    await expect(uploadAttachment(new File(['hello'], 'file.txt'))).rejects.toThrow('HTTP 413')
    expect(methods).toEqual(['POST', 'PUT', 'DELETE'])
  })

  it('reports an expired login instead of parsing a login page as JSON', async () => {
    globalThis.fetch = async () => reply({}, 401)
    await expect(uploadAttachment(new File(['hello'], 'file.txt'))).rejects.toThrow('重新登录')
  })

  it('rejects empty and oversized files before making any network requests', async () => {
    globalThis.fetch = () => {
      throw new Error('unexpected network request')
    }
    await expect(uploadAttachment(new File([], 'empty'))).rejects.toThrow('文件为空')
    await expect(uploadAttachment({ size: 64 * 1024 * 1024 + 1 })).rejects.toThrow('64 MiB')
  })

  it('cancels all parallel work before deleting an interrupted upload', async () => {
    const controller = new AbortController()
    const methods = []
    globalThis.fetch = async (url, options) => {
      methods.push(options.method)
      if (url === '/api/uploads') return reply({ ok: true, id: 'cancel-1', chunkSize: CHUNK })
      if (options.method === 'DELETE') {
        expect(options.signal.aborted).toBe(false)
        return reply({ ok: true })
      }
      controller.abort(new Error('user cancelled'))
      options.signal.throwIfAborted()
    }
    await expect(
      uploadAttachment(new File(['hello'], 'file.txt'), { signal: controller.signal })
    ).rejects.toThrow('user cancelled')
    expect(methods).toEqual(['POST', 'PUT', 'DELETE'])
  })
})
