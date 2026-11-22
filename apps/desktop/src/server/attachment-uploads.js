import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveUploadedImage as persistImage } from '../host/chat-images.js'
import { saveAttachmentBytes as persistAttachment } from '../host/attachments.js'

export const UPLOAD_CHUNK_SIZE = 512 * 1024
const MAX_FILE_SIZE = 64 * 1024 * 1024
const MAX_SESSIONS = 8
const MAX_RECEIPTS = 128
const MAX_METADATA_SIZE = 8 * 1024
const IDLE_MS = 10 * 60 * 1000

class UploadError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function fail(status, code, message) {
  throw new UploadError(status, code, message)
}

// 不用 async iterator：提前退出 iterator 会 destroy 请求，客户端就收不到 JSON 413。
function readBody(req, limit, signal) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const finish = (error) => {
      req.off('data', data)
      req.off('end', end)
      req.off('aborted', aborted)
      req.off('error', aborted)
      signal.removeEventListener('abort', stopped)
      if (error) {
        req.resume()
        // IncomingMessage 在 aborted 之后还可能发 ECONNRESET。
        req.once('error', () => {})
        reject(error)
      } else resolve(Buffer.concat(chunks, size))
    }
    const data = (chunk) => {
      size += chunk.length
      if (size > limit) finish(new UploadError(413, 'body_too_large', '上传请求体超过大小上限'))
      else chunks.push(chunk)
    }
    const end = () => finish()
    const aborted = () =>
      finish(new UploadError(400, 'request_aborted', '上传请求已中断，请重新上传'))
    const stopped = () =>
      finish(
        signal.reason instanceof UploadError
          ? signal.reason
          : new UploadError(503, 'uploads_closed', '上传服务已关闭')
      )
    if (signal.aborted) return stopped()
    if (req.aborted || req.destroyed) return aborted()
    if (Number(req.headers['content-length']) > limit) {
      return finish(new UploadError(413, 'body_too_large', '上传请求体超过大小上限'))
    }
    req.on('data', data)
    req.once('end', end)
    req.once('aborted', aborted)
    req.once('error', aborted)
    signal.addEventListener('abort', stopped, { once: true })
  })
}

/** 挂载方负责在调用前完成访问凭据及 Host / Origin 检查。状态只保存在当前进程。 */
export function createAttachmentUploads({
  sendJson,
  saveUploadedImage = persistImage,
  saveAttachmentBytes = persistAttachment,
  tempDir = tmpdir(),
  now = Date.now,
  setInterval: schedule = setInterval,
  clearInterval: unschedule = clearInterval
}) {
  const root = mkdtempSync(join(tempDir, 'mica-attachment-uploads-'))
  const sessions = new Map()
  const operations = new Set()
  const shutdown = new AbortController()
  let disposal

  function cancel(session) {
    session.cancelled = true
    session.abort.abort(new UploadError(410, 'upload_cancelled', '上传已取消，请重新上传'))
  }

  function acquire(session) {
    if (session.cancelled) fail(410, 'upload_cancelled', '上传已取消，请重新上传')
    if (session.active++ === 0)
      session.idle = new Promise((resolve) => {
        session.resolveIdle = resolve
      })
    session.touchedAt = now()
  }

  function release(session) {
    session.touchedAt = now()
    if (--session.active === 0) session.resolveIdle()
  }

  function cleanup(session) {
    if (!session.cleanup) {
      session.cleanup = (async () => {
        await session.idle
        try {
          await session.file?.close()
        } finally {
          await rm(session.path, { force: true })
          sessions.delete(session.id)
        }
      })()
    }
    return session.cleanup
  }

  async function sweep() {
    await Promise.allSettled(
      [...sessions.values()]
        .filter((session) => session.active === 0 && now() - session.touchedAt >= IDLE_MS)
        .map((session) => {
          cancel(session)
          return cleanup(session)
        })
    )
  }

  const timer = schedule(sweep, 60 * 1000)
  timer?.unref?.()

  async function create(req) {
    let metadata
    const bytes = await readBody(req, MAX_METADATA_SIZE, shutdown.signal)
    try {
      metadata = JSON.parse(bytes.toString('utf8'))
    } catch {
      fail(400, 'invalid_json', '上传信息不是合法 JSON')
    }
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      !['image', 'attachment'].includes(metadata.kind) ||
      typeof metadata.name !== 'string' ||
      !metadata.name.trim() ||
      metadata.name.length > 1024 ||
      typeof metadata.type !== 'string' ||
      metadata.type.length > 256 ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size <= 0
    ) {
      fail(400, 'invalid_metadata', '上传信息无效：需要文件名、类型、非零整数大小和文件种类')
    }
    if (metadata.size > MAX_FILE_SIZE) fail(413, 'file_too_large', '文件不能超过 64 MiB')
    const unfinished = [...sessions.values()].filter((session) => !session.result)
    if (unfinished.length >= MAX_SESSIONS)
      fail(429, 'too_many_uploads', '最多同时保留 8 个未完成上传，请取消已有上传或稍后重试')
    // 完成回执用于重试丢失的响应，不能占用后续文件的上传名额。
    const receipts = [...sessions.values()]
      .filter((session) => session.result && session.active === 0)
      .sort((a, b) => a.touchedAt - b.touchedAt)
    for (const receipt of receipts.slice(0, Math.max(0, receipts.length - MAX_RECEIPTS))) {
      sessions.delete(receipt.id)
    }
    const id = randomUUID()
    const session = {
      id,
      name: metadata.name,
      type: metadata.type.trim().toLowerCase(),
      size: metadata.size,
      kind: metadata.kind,
      path: join(root, id),
      active: 0,
      touchedAt: now(),
      cancelled: false,
      chunks: new Map(),
      puts: new Set(),
      state: 'uploading',
      abort: new AbortController()
    }
    // 在第一次异步 IO 之前占位，避免并发创建绕过数量上限。
    sessions.set(id, session)
    acquire(session)
    try {
      session.file = await open(session.path, 'wx+', 0o600)
      if (shutdown.signal.aborted || req.aborted)
        fail(400, 'request_aborted', '上传请求已中断，请重新上传')
      return { ok: true, id, chunkSize: UPLOAD_CHUNK_SIZE }
    } catch (error) {
      cancel(session)
      throw error
    } finally {
      release(session)
      if (session.cancelled) await cleanup(session)
    }
  }

  async function put(req, session, url) {
    if (session.state !== 'uploading')
      fail(409, 'upload_completing', '上传正在完成或已完成，不能再写入分块')
    const offsets = url.searchParams.getAll('offset')
    if (offsets.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(offsets[0]))
      fail(400, 'invalid_offset', '分块偏移必须是非负整数')
    const offset = Number(offsets[0])
    if (
      !Number.isSafeInteger(offset) ||
      offset >= session.size ||
      offset % UPLOAD_CHUNK_SIZE !== 0
    ) {
      fail(400, 'invalid_offset', '分块偏移必须按 512 KiB 对齐且位于文件范围内')
    }
    const expected = Math.min(UPLOAD_CHUNK_SIZE, session.size - offset)
    const bytes = await readBody(
      req,
      expected,
      AbortSignal.any([shutdown.signal, session.abort.signal])
    )
    if (bytes.length !== expected)
      fail(400, 'invalid_chunk_size', '分块大小必须为 512 KiB，只有最后一块可以更小')
    if (session.cancelled) fail(410, 'upload_cancelled', '上传已取消，请重新上传')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const existing = session.chunks.get(offset)
    if (existing) {
      if (existing.hash !== hash) fail(409, 'chunk_conflict', '同一偏移的分块内容不同，请重新上传')
      await existing.written
    } else {
      const chunk = { hash }
      chunk.written = (async () => {
        let written = 0
        while (written < bytes.length) {
          const result = await session.file.write(
            bytes,
            written,
            bytes.length - written,
            offset + written
          )
          if (!result.bytesWritten) throw new Error('Empty write')
          written += result.bytesWritten
        }
      })()
      session.chunks.set(offset, chunk)
      try {
        await chunk.written
      } catch (error) {
        session.chunks.delete(offset)
        throw error
      }
    }
    if (session.cancelled) fail(410, 'upload_cancelled', '上传已取消，请重新上传')
    return { ok: true }
  }

  async function complete(session) {
    if (session.result) return session.result
    if (session.completion) return session.completion
    session.state = 'completing'
    session.completion = (async () => {
      await Promise.allSettled([...session.puts])
      if (session.cancelled) fail(410, 'upload_cancelled', '上传已取消，请重新上传')
      if (session.chunks.size !== Math.ceil(session.size / UPLOAD_CHUNK_SIZE)) {
        fail(409, 'missing_chunks', '文件分块尚未上传齐全，请重试缺失的分块')
      }
      const bytes = await readFile(session.path)
      if (bytes.length !== session.size) fail(409, 'missing_chunks', '文件大小不完整，请重新上传')
      if (session.cancelled) fail(410, 'upload_cancelled', '上传已取消，请重新上传')
      // 保存调用开始即为提交点；DELETE 只清 staging，不能删除已经保存的用户附件。
      const result =
        session.kind === 'image'
          ? await saveUploadedImage(bytes, session.type)
          : await saveAttachmentBytes(bytes, session.name)
      if (!result?.ok && result?.code === 'unsupported_image')
        fail(
          415,
          'unsupported_image',
          result?.error || '不支持的图片格式，请使用 PNG、JPEG、WebP 或 GIF'
        )
      if (!result?.ok) fail(500, 'save_failed', '保存上传文件失败，请稍后重试')
      session.result = result
      session.state = 'completed'
      await session.file.close()
      session.file = null
      await rm(session.path, { force: true })
      return result
    })()
    try {
      return await session.completion
    } finally {
      session.completion = null
      if (!session.result) session.state = 'uploading'
    }
  }

  async function dispatch(req, url, match) {
    if (shutdown.signal.aborted) fail(503, 'uploads_closed', '上传服务已关闭')
    if (url.pathname === '/api/uploads') {
      if (req.method !== 'POST') fail(405, 'method_not_allowed', '创建上传只支持 POST')
      return create(req)
    }
    if (!match) fail(404, 'upload_not_found', '找不到这个上传')
    const [, id, finishing] = match
    const session = sessions.get(id)
    if (!session) fail(404, 'upload_not_found', '上传不存在或已过期，请重新上传')
    if (req.method === 'DELETE' && !finishing) {
      cancel(session)
      await cleanup(session)
      return { ok: true }
    }
    acquire(session)
    try {
      if (req.method === 'PUT' && !finishing) {
        const pending = put(req, session, url)
        session.puts.add(pending)
        try {
          return await pending
        } finally {
          session.puts.delete(pending)
        }
      }
      if (req.method === 'POST' && finishing) {
        await readBody(
          req,
          MAX_METADATA_SIZE,
          AbortSignal.any([shutdown.signal, session.abort.signal])
        )
        return await complete(session)
      }
      fail(405, 'method_not_allowed', '这个上传地址不支持该请求方法')
    } finally {
      release(session)
      if (session.cancelled) await cleanup(session)
    }
  }

  async function handle(req, res, url) {
    if (typeof url === 'string') url = new URL(url, 'http://localhost')
    if (url.pathname !== '/api/uploads' && !url.pathname.startsWith('/api/uploads/')) return false
    const match =
      /^\/api\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/complete)?$/.exec(
        url.pathname
      )
    const pending = dispatch(req, url, match)
    operations.add(pending)
    try {
      const result = await pending
      if (!req.aborted && !res.destroyed && !res.writableEnded) await sendJson(res, 200, result)
    } catch (error) {
      req.resume()
      if (!req.aborted && !res.destroyed && !res.writableEnded) {
        const known = error instanceof UploadError
        await sendJson(res, known ? error.status : 500, {
          ok: false,
          code: known ? error.code : 'upload_failed',
          error: known ? error.message : '上传处理失败，请稍后重试'
        })
      }
    } finally {
      operations.delete(pending)
    }
    return true
  }

  function dispose() {
    if (!disposal) {
      unschedule(timer)
      shutdown.abort()
      for (const session of sessions.values()) cancel(session)
      disposal = (async () => {
        await Promise.allSettled([...operations])
        await Promise.allSettled([...sessions.values()].map(cleanup))
        await rm(root, { recursive: true, force: true })
      })()
    }
    return disposal
  }

  return { handle, dispose }
}
