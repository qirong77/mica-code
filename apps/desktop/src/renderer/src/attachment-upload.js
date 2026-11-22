// 单次请求保持在常见反向代理的 1 MiB 限制以内；三路并行减少高 RTT 下逐块等待。
const CHUNK_BYTES = 512 * 1024
const MAX_FILE_BYTES = 64 * 1024 * 1024
const PARALLEL_CHUNKS = 3

class UploadError extends Error {
  constructor(message, retryable = false) {
    super(message)
    this.retryable = retryable
  }
}

async function uploadRequest(url, options, signal, retry = false) {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted()
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(), 45000)
    try {
      const response = await fetch(url, { ...options, signal: controller.signal })
      if (!response.ok) {
        if (response.status === 401 || response.status === 403)
          throw new UploadError('登录已失效或访问被拒绝，请重新登录后上传')
        if (response.status === 413)
          throw new UploadError('反向代理拒绝了文件分块（HTTP 413），请检查上传大小限制')
        let message
        try {
          message = (await response.json())?.error
        } catch {
          /* 代理可能返回 HTML */
        }
        throw new UploadError(
          message || `上传失败（HTTP ${response.status}）`,
          response.status >= 500
        )
      }
      let body
      try {
        body = await response.json()
      } catch {
        throw new UploadError('上传接口没有返回有效结果，请确认登录状态和服务版本')
      }
      if (body?.ok !== true) throw new UploadError(body?.error || '上传失败')
      return body
    } catch (error) {
      signal?.throwIfAborted()
      const retryable = !(error instanceof UploadError) || error.retryable
      if (!retry || !retryable || attempt >= 2) {
        if (error instanceof UploadError) throw error
        throw new UploadError(
          controller.signal.aborted
            ? '上传超时，请检查网络后重试'
            : '上传连接中断，请检查网络后重试'
        )
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
}

/** 图片与普通附件共用二进制上传；只重试幂等的分块和完成请求。 */
export async function uploadAttachment(file, { kind = 'attachment', onProgress, signal } = {}) {
  if (!file || !Number.isSafeInteger(file.size) || file.size <= 0)
    throw new UploadError('文件为空或无法读取')
  if (file.size > MAX_FILE_BYTES) throw new UploadError('单个附件不能超过 64 MiB')
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal?.throwIfAborted()
  signal?.addEventListener('abort', abort, { once: true })
  let id
  try {
    onProgress?.({ loaded: 0, total: file.size, phase: 'uploading' })
    const created = await uploadRequest(
      '/api/uploads',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: file.name || 'file',
          type: file.type || '',
          size: file.size,
          kind
        })
      },
      controller.signal
    )
    id = created.id
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/i.test(id) || created.chunkSize !== CHUNK_BYTES)
      throw new UploadError('上传接口版本不一致，请刷新页面后重试')
    const url = `/api/uploads/${encodeURIComponent(id)}`
    let nextOffset = 0
    let loaded = 0
    const worker = async () => {
      try {
        while (nextOffset < file.size) {
          controller.signal.throwIfAborted()
          const offset = nextOffset
          nextOffset += CHUNK_BYTES
          const chunk = file.slice(offset, Math.min(offset + CHUNK_BYTES, file.size))
          await uploadRequest(
            `${url}?offset=${offset}`,
            {
              method: 'PUT',
              headers: { 'content-type': 'application/octet-stream' },
              body: chunk
            },
            controller.signal,
            true
          )
          loaded += chunk.size
          onProgress?.({ loaded, total: file.size, phase: 'uploading' })
        }
      } catch (error) {
        controller.abort(error)
        throw error
      }
    }
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(PARALLEL_CHUNKS, Math.ceil(file.size / CHUNK_BYTES)) }, worker)
    )
    const failure = results.find((result) => result.status === 'rejected')
    if (failure) throw controller.signal.reason || failure.reason
    onProgress?.({ loaded: file.size, total: file.size, phase: 'saving' })
    const result = await uploadRequest(
      `${url}/complete`,
      { method: 'POST' },
      controller.signal,
      true
    )
    onProgress?.({ loaded: file.size, total: file.size, phase: 'done' })
    return result
  } catch (error) {
    controller.abort(error)
    if (id) {
      // 清理使用独立信号，不能沿用刚刚中断的上传信号。
      await fetch(`/api/uploads/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(5000)
      }).catch(() => {})
    }
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}
