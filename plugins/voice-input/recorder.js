export const MAX_RECORDING_MS = 120_000
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024

const FORMATS = [
  ['audio/webm;codecs=opus', 'webm'],
  ['audio/mp4', 'm4a'],
  ['audio/ogg;codecs=opus', 'ogg'],
  ['audio/webm', 'webm']
]

export function recordingFormat(Recorder) {
  return FORMATS.find(([mime]) => Recorder.isTypeSupported?.(mime)) || null
}

export function microphoneError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return '无法使用麦克风，请在浏览器的网站设置中允许麦克风权限后重试。'
  }
  if (error?.name === 'NotFoundError') return '没有找到可用的麦克风。'
  if (error?.name === 'NotReadableError') return '麦克风正被其他应用占用，请关闭后重试。'
  return error?.message || '录音失败，请重试。'
}

/** A single capture owns its microphone, timers and async replies, even after navigation. */
export function createVoiceInput({
  mediaDevices = globalThis.navigator?.mediaDevices,
  Recorder = globalThis.MediaRecorder,
  secure = globalThis.isSecureContext,
  check,
  upload,
  transcribe,
  discard,
  appendText,
  onChange,
  now = () => Date.now(),
  schedule = (callback, ms) => setTimeout(callback, ms),
  unschedule = (timer) => clearTimeout(timer),
  maxDuration = MAX_RECORDING_MS,
  maxBytes = MAX_AUDIO_BYTES
}) {
  let version = 0
  let disposed = false
  let capture = null
  let pendingBlob = null
  let state = { status: 'idle', elapsed: 0, error: '', retryable: false }

  function update(next) {
    state = { ...state, ...next }
    if (!disposed) onChange?.(state)
  }

  function release(item) {
    if (!item) return
    unschedule(item.timer)
    unschedule(item.tick)
    for (const track of item.stream?.getTracks?.() || []) track.stop()
  }

  function dropCapture() {
    const item = capture
    capture = null
    if (!item) return
    // Detach first: stop() may synchronously deliver a final chunk in test/embedded engines.
    if (item.recorder) {
      item.recorder.ondataavailable = null
      item.recorder.onstop = null
      item.recorder.onerror = null
      if (item.recorder.state !== 'inactive') {
        try { item.recorder.stop() } catch { /* Already interrupted by the browser. */ }
      }
    }
    release(item)
  }

  function cancel() {
    version += 1
    dropCapture()
    pendingBlob = null
    update({ status: 'idle', elapsed: 0, error: '', retryable: false })
  }

  async function recognize(blob, token) {
    update({ status: 'processing', error: '', retryable: false })
    let path = ''
    try {
      const result = await upload(blob)
      if (!result?.ok || !result.path) throw new Error(result?.error || '录音上传失败，请检查网络后重试。')
      path = result.path
      if (disposed || token !== version) {
        await discard?.(path)
        return
      }
      const text = await transcribe(path)
      // The backend removes its temporary file, including on transcription errors.
      path = ''
      if (disposed || token !== version) return
      if (typeof text !== 'string' || !text.trim()) throw new Error('没有识别到文字，请重新录音。')
      appendText(text.trim())
      pendingBlob = null
      update({ status: 'idle', elapsed: 0, error: '', retryable: false })
    } catch (error) {
      if (path) await Promise.resolve(discard?.(path)).catch(() => {})
      if (disposed || token !== version) return
      update({ status: 'error', error: error?.message || '语音转文字失败，请重试。', retryable: true })
    }
  }

  async function start() {
    if (disposed || ['requesting', 'recording', 'processing'].includes(state.status)) return
    cancel()
    const token = version
    if (!secure || !mediaDevices?.getUserMedia || !Recorder) {
      update({ status: 'error', error: !secure
        ? '语音输入需要 HTTPS，请使用手机访问链接打开。'
        : '当前浏览器不支持网页录音，请使用 Safari 或 Chrome。' })
      return
    }
    const format = recordingFormat(Recorder)
    if (!format) {
      update({ status: 'error', error: '当前浏览器没有可用的录音格式，请使用新版 Safari 或 Chrome。' })
      return
    }
    update({ status: 'requesting', elapsed: 0, error: '', retryable: false })
    const item = { stream: null, recorder: null, timer: null, tick: null, chunks: [], bytes: 0 }
    capture = item
    try {
      // Request permission in the original click; late permission replies must release their stream.
      const microphone = mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        item.stream = stream
        if (disposed || token !== version || capture !== item) release(item)
        return stream
      })
      await Promise.all([microphone, Promise.resolve().then(() => check?.())])
      if (disposed || token !== version || capture !== item) return
      const [mime, extension] = format
      const recorder = new Recorder(item.stream, { mimeType: mime, audioBitsPerSecond: 64_000 })
      item.recorder = recorder
      item.started = now()
      recorder.ondataavailable = (event) => {
        if (capture !== item || !event.data?.size) return
        item.bytes += event.data.size
        if (item.bytes > maxBytes) {
          dropCapture()
          update({ status: 'error', error: '录音超过 10MB，请缩短后重新录音。', retryable: false })
          return
        }
        item.chunks.push(event.data)
      }
      recorder.onerror = () => {
        if (capture !== item) return
        dropCapture()
        update({ status: 'error', error: '录音被浏览器中断，请重新录音。', retryable: false })
      }
      recorder.onstop = () => {
        if (capture !== item || token !== version) return
        capture = null
        release(item)
        const actualType = recorder.mimeType || mime
        const blob = new Blob(item.chunks, { type: actualType })
        if (!blob.size) {
          update({ status: 'error', error: '没有录到声音，请重新录音。', retryable: false })
          return
        }
        pendingBlob = new File([blob], `voice-input-${globalThis.crypto.randomUUID()}.${extension}`, { type: actualType })
        void recognize(pendingBlob, token)
      }
      recorder.start(1000)
      update({ status: 'recording' })
      const tick = () => {
        if (capture !== item) return
        update({ elapsed: Math.floor((now() - item.started) / 1000) })
        item.tick = schedule(tick, 1000)
      }
      item.tick = schedule(tick, 1000)
      item.timer = schedule(stop, maxDuration)
    } catch (error) {
      if (disposed || token !== version) return
      dropCapture()
      update({ status: 'error', error: microphoneError(error), retryable: false })
    }
  }

  function stop() {
    const item = capture
    if (!item?.recorder || item.recorder.state === 'inactive') return
    unschedule(item.timer)
    unschedule(item.tick)
    update({ status: 'processing' })
    try {
      item.recorder.stop()
      release(item)
    } catch (error) {
      dropCapture()
      update({ status: 'error', error: microphoneError(error), retryable: false })
    }
  }

  function retry() {
    if (disposed || state.status !== 'error' || !pendingBlob) return
    void recognize(pendingBlob, ++version)
  }

  return {
    start, stop, cancel, retry,
    state: () => state,
    dispose() {
      disposed = true
      cancel()
    }
  }
}
