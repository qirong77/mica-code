export function nativeStatusFromResult(result) {
  if (!result || typeof result !== 'object') return null
  const status = result.status
  if (status && typeof status === 'object' && typeof status.status === 'string') return status
  if (typeof status === 'string') return result
  return null
}

/**
 * A status read is observational. It must not make a package which is already
 * downloading/downloaded disappear because an older poll or another window
 * returned an idle/checking result.
 */
export function preserveNativeStatus(current, next) {
  if (!next || typeof next.status !== 'string') return current || next || null
  if (current?.status === 'downloaded' && !['downloaded', 'installing'].includes(next.status)) return current
  if (current?.status === 'installing' && next.status !== 'installing' && !(next.status === 'downloaded' && next.error)) return current
  if (current?.status === 'downloading' && ['idle', 'not-available', 'available', 'checking', 'unsupported'].includes(next.status)) return current
  return next
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error || '未知错误')
}

function failedResult(action, error) {
  return {
    ok: false,
    action,
    rejected: true,
    error: errorText(error)
  }
}

/**
 * Run one user-initiated native update flow.
 *
 * The function deliberately owns the check -> download transition instead of
 * making the component infer it from a stale status. `onStatus` is called for
 * optimistic progress as well as the native response, so a click is visible
 * before a slow IPC call returns. Native failures are returned to the caller;
 * they are never converted to null or silently ignored.
 */
export async function runNativeUpdate({ bridge, currentStatus = null, onStatus } = {}) {
  if (!bridge) return { kind: 'source', reason: 'browser', result: null }

  const apply = (result) => {
    const status = nativeStatusFromResult(result)
    if (status) onStatus?.(status)
    return result
  }
  const call = async (action, optimisticStatus) => {
    if (optimisticStatus) onStatus?.({ status: optimisticStatus, progress: optimisticStatus === 'downloading' ? 0 : null })
    const method = bridge[action]
    try {
      if (typeof method !== 'function') throw new Error(`本机更新接口缺少 ${action}`)
      const result = await method()
      if (!result || typeof result.ok !== 'boolean') throw new Error('更新接口返回不完整')
      if (result.ok === false && !nativeStatusFromResult(result)) {
        onStatus?.({
          status: action === 'install' ? 'downloaded' : ['unsupported', 'remote-window'].includes(result.code) ? 'unsupported' : 'error',
          error: result.error || null
        })
      }
      return apply(result)
    } catch (error) {
      const result = failedResult(action, error)
      onStatus?.({ status: action === 'install' ? 'downloaded' : 'error', error: result.error, progress: null })
      return result
    }
  }

  const install = async (result) => ({
    kind: 'install',
    result,
    status: nativeStatusFromResult(result)
  })
  const download = async (result) => ({
    kind: 'download',
    result,
    status: nativeStatusFromResult(result)
  })

  if (currentStatus === 'downloaded') return install(await call('install', null))
  if (currentStatus === 'available') return download(await call('download', 'downloading'))
  if (['checking', 'downloading', 'installing'].includes(currentStatus)) {
    return { kind: 'pending', result: { ok: true, status: { status: currentStatus } }, status: { status: currentStatus } }
  }

  const checked = await call('check', 'checking')
  const checkedStatus = nativeStatusFromResult(checked)
  if (checkedStatus?.status === 'error') return { kind: 'error', result: { ...checked, ok: false, error: checkedStatus.error }, status: checkedStatus }
  if (checkedStatus?.status === 'downloaded') return install(await call('install', null))
  if (checkedStatus?.status === 'available') return download(await call('download', 'downloading'))
  if (['checking', 'downloading', 'installing'].includes(checkedStatus?.status)) {
    return { kind: 'pending', result: checked, status: checkedStatus }
  }
  if (checked?.ok === false) {
    if (checked.code === 'unsupported' || checked.code === 'remote-window') {
      return { kind: 'source', reason: checked.code, result: checked, status: checkedStatus }
    }
    return { kind: 'error', result: checked, status: checkedStatus }
  }
  return { kind: 'source', reason: checkedStatus?.status === 'not-available' ? 'no-package' : 'unsupported', result: checked, status: checkedStatus }
}

export function updateButtonState(remote, native) {
  if (native?.status === 'installing') return { visible: true, label: '正在重启…', tone: 'primary' }
  if (native?.status === 'downloaded') return { visible: true, label: '重启更新', tone: 'primary' }
  if (native?.status === 'downloading') {
    const percent = Number.isFinite(native.progress) ? ` ${Math.round(native.progress)}%` : ''
    return { visible: true, label: `下载更新${percent}`, tone: 'primary' }
  }
  if (native?.status === 'checking') return { visible: true, label: '检查更新…', tone: 'primary' }
  if (native?.status === 'available') return { visible: true, label: '下载更新', tone: 'primary' }
  if (native?.status === 'error') return { visible: true, label: '更新失败', tone: 'primary' }
  if (remote?.available) return { visible: true, label: '有新版本', tone: 'primary' }
  return { visible: false, label: '', tone: undefined }
}

export function updateCheckUrl(force = false) {
  return force ? '/api/update/check?force=1' : '/api/update/check'
}
