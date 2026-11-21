export const OFFICIAL_RELEASE_URL = 'https://github.com/qirong77/mica-code/releases/latest'

export function nativeStatusFromResult(result, action = null) {
  if (!result || typeof result !== 'object') return null
  const value = result.status
  const status =
    value && typeof value === 'object' && typeof value.status === 'string'
      ? { ...value }
      : typeof value === 'string'
        ? { ...result }
        : null
  if (!status && result.ok !== false) return null
  const next = status || {}
  for (const field of ['reason', 'message', 'error', 'releaseUrl']) {
    if (next[field] == null && result[field] != null) next[field] = result[field]
  }
  // Failure envelopes win over stale success statuses. Keep their metadata and
  // the original envelope for diagnosis, but never expose a failed check as a
  // downloadable package. Install failures retain an already downloaded file.
  if (result.ok === false) {
    const unsupported =
      result.code === 'unsupported' ||
      result.code === 'remote-window' ||
      next.status === 'unsupported'
    next.status = unsupported
      ? 'unsupported'
      : action === 'install' || next.status === 'downloaded'
        ? 'downloaded'
        : 'error'
    if (!next.reason && unsupported) next.reason = result.code
  }
  return next
}

/**
 * A status read is observational. It must not make a package which is already
 * downloading/downloaded disappear because an older poll or another window
 * returned an idle/checking result.
 */
export function preserveNativeStatus(current, next) {
  if (!next || typeof next.status !== 'string') return current || next || null
  if (current?.status === 'downloaded' && !['downloaded', 'installing'].includes(next.status))
    return current
  if (
    current?.status === 'installing' &&
    next.status !== 'installing' &&
    !(next.status === 'downloaded' && next.error)
  )
    return current
  if (
    current?.status === 'downloading' &&
    ['idle', 'not-available', 'available', 'checking', 'unsupported'].includes(next.status)
  )
    return current
  return next
}

/** A foreground action result is authoritative; background events are not. */
export function mergeNativeStatus(current, next, { force = false } = {}) {
  return force ? next : preserveNativeStatus(current, next)
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

  const call = async (action, optimisticStatus) => {
    if (optimisticStatus)
      onStatus?.({
        status: optimisticStatus,
        progress: optimisticStatus === 'downloading' ? 0 : null
      })
    try {
      const method = bridge[action]
      if (typeof method !== 'function') throw new Error(`本机更新接口缺少 ${action}`)
      const result = await method()
      if (!result || typeof result.ok !== 'boolean') throw new Error('更新接口返回不完整')
      const status = nativeStatusFromResult(result, action)
      if (!status) throw new Error('更新接口未返回有效状态，无法确认更新结果')
      // The result of a foreground action is authoritative. The renderer may
      // have optimistically shown `downloading`; do not let the normal polling
      // preservation rule keep that stale state after an unsupported/error
      // envelope comes back.
      onStatus?.(status, { final: true })
      return result
    } catch (error) {
      const result = failedResult(action, error)
      onStatus?.(
        {
          status: action === 'install' ? 'downloaded' : 'error',
          error: result.error,
          progress: null
        },
        { final: true }
      )
      return result
    }
  }

  const outcome = (kind, result, action = null) => {
    const status = nativeStatusFromResult(result, action)
    if (
      result?.code === 'unsupported' ||
      result?.code === 'remote-window' ||
      status?.status === 'unsupported'
    ) {
      return {
        kind: 'source',
        reason:
          result?.code === 'remote-window' ? 'remote-window' : status?.reason || 'unsupported',
        message: status?.message || null,
        result,
        status
      }
    }
    if (result?.ok === false || status?.status === 'error') {
      return {
        kind: kind === 'install' ? 'install' : 'error',
        result:
          result?.ok === false
            ? result
            : { ...result, ok: false, error: result?.error || status?.error || null },
        status
      }
    }
    if (status?.status === 'not-available')
      return { kind: 'source', reason: 'no-package', result, status }
    return { kind, result, status }
  }

  if (currentStatus === 'downloaded')
    return outcome('install', await call('install', null), 'install')
  if (currentStatus === 'available')
    return outcome('download', await call('download', 'downloading'), 'download')
  if (['checking', 'downloading', 'installing'].includes(currentStatus)) {
    return {
      kind: 'pending',
      result: { ok: true, status: { status: currentStatus } },
      status: { status: currentStatus }
    }
  }

  const checked = await call('check', 'checking')
  const checkedOutcome = outcome('source', checked, 'check')
  const checkedStatus = checkedOutcome.status
  // Inspect failures before any status-driven download/install transition.
  if (
    checked.ok === false ||
    checkedOutcome.kind === 'error' ||
    checkedStatus?.status === 'unsupported'
  )
    return checkedOutcome
  // A stale renderer may first discover a downloaded package during a check.
  // Expose the explicit restart action instead of installing from that click.
  if (checkedStatus?.status === 'downloaded') return outcome('download', checked)
  if (checkedStatus?.status === 'available')
    return outcome('download', await call('download', 'downloading'), 'download')
  if (['checking', 'downloading', 'installing'].includes(checkedStatus?.status)) {
    return { kind: 'pending', result: checked, status: checkedStatus }
  }
  return { ...checkedOutcome, reason: checkedOutcome.reason || 'capability-unavailable' }
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
  // The native feed is authoritative for installable versions. A newer source
  // commit must not resurrect an update after the feed reports no package.
  if (native?.status === 'not-available') return { visible: false, label: '', tone: undefined }
  if (remote?.available) return { visible: true, label: '有新提交', tone: 'primary' }
  // 不支持自动更新的环境（源码 / 开发模式、本机 --dir 包、macOS 未发布等）不占底部常驻入口：
  // 一个点不开任何更新的「更新说明」只会让人以为这里能更新。原因说明仍随点击反馈出现在弹窗里。
  return { visible: false, label: '', tone: undefined }
}

export function updateLinks(remote) {
  const entries = [
    [OFFICIAL_RELEASE_URL, '打开正式 Release 下载页'],
    [remote?.latestUrl, '打开最新提交'],
    [remote?.repository, '打开项目仓库']
  ]
  const seen = new Set()
  return entries.flatMap(([href, label]) => {
    if (typeof href !== 'string' || !/^https?:\/\//i.test(href) || seen.has(href)) return []
    seen.add(href)
    return [{ href, label }]
  })
}

const SOURCE_MODES = {
  development: ['源码 / 开发模式', '当前运行的是源码 / 开发模式，不使用桌面自动安装器。'],
  'local-build': ['本机构建包', '当前是本机构建的桌面包，没有正式自动更新配置，不能自动下载安装。'],
  'unsupported-platform': ['平台暂不支持', '当前平台暂不支持桌面自动更新。'],
  'unsupported-architecture': ['架构暂不支持', '当前平台 / 架构没有对应的桌面更新包。'],
  'appimage-required': [
    '安装方式不支持',
    '当前 Linux 安装方式不支持自动更新，需要通过 AppImage 运行。'
  ],
  'macos-not-published': [
    'macOS 暂未发布',
    'macOS 桌面更新尚未发布：系统安装器要求 Developer ID 正式签名的安装包，请用正式下载页手动安装。'
  ],
  'updater-disabled': ['自动更新已停用', '本机自动更新已停用，不会自动下载安装更新。'],
  'capability-unavailable': ['本机安装器不可用', '当前桌面环境无法使用本机更新安装器。'],
  'feed-unavailable': ['更新源不可用', '当前无法读取桌面更新源，不能确认是否有可下载安装的更新。'],
  'package-unavailable': ['安装包不完整', '更新清单没有提供适用于当前平台和架构的完整安装包。'],
  'checksum-mismatch': ['更新包校验失败', '下载的更新包没有通过校验，已拒绝安装。'],
  'stale-update-state': ['更新缓存失效', '本机保存的更新缓存已失效，需要重新检查并下载。'],
  'version-mismatch': ['版本校验失败', '下载的版本与检查结果不一致，已拒绝安装。']
}

export function sourceUpdateDetails(outcome) {
  const result = outcome?.result
  const status = outcome?.status || nativeStatusFromResult(result)
  const reason = outcome?.reason || status?.reason || result?.reason || 'unsupported'
  if (reason === 'browser') {
    return {
      mode: '浏览器页面',
      detail:
        '浏览器页面不能调用桌面安装器，也不会替本机或远程服务安装或重启。下面的正式 Release 下载页可查看可用安装包；服务更新仍走它自己的部署流程。'
    }
  }
  if (reason === 'remote-window' || result?.code === 'remote-window') {
    return {
      mode: '远程页面',
      detail:
        '当前页面是远程会话，不能安装本机应用，请切回本机窗口。查看下载页或提交链接不会更新远程服务。'
    }
  }
  if (reason === 'no-package') {
    return {
      mode: '无可用桌面更新',
      detail: `${status?.message || '本机更新源没有提供可下载的新桌面包。'}\n源码提交领先不代表正式 Release 已发布，可在下面的正式 Release 下载页查看当前可用的安装包。`
    }
  }
  const [mode, fallback] = SOURCE_MODES[reason] || [
    '暂不支持自动更新',
    '当前环境暂不支持桌面自动更新。'
  ]
  const message =
    status?.message || outcome?.message || result?.message || result?.error || fallback
  return {
    mode,
    detail: `${message}\n可在下面的正式 Release 下载页查看当前可用的安装包；提交链接只用于查看源码变化，不会安装或重启应用。`
  }
}

export function nativeFailureMessage(result) {
  const status = nativeStatusFromResult(result)
  const message = status?.message || result?.message
  const blockers = Array.isArray(result?.blockers)
    ? result.blockers
        .map((item) => item?.label)
        .filter(Boolean)
        .join('；')
    : ''
  if (result?.code === 'busy')
    return `当前仍有工作在运行，更新包已保留。${blockers ? ` ${blockers}` : ''}`
  if (result?.code === 'activity-unavailable')
    return message || result.error || '无法确认当前工作状态，暂不重启更新。'
  if (result?.code === 'cancelled') return '已取消重启，更新包仍保留。'
  if (result?.code === 'remote-window')
    return sourceUpdateDetails({ reason: 'remote-window', result }).detail
  if (result?.code === 'unsupported' || status?.status === 'unsupported')
    return sourceUpdateDetails({ result, status }).detail
  return message || result?.error || status?.error || '更新操作没有完成。'
}

export function updateCheckUrl(force = false) {
  return force ? '/api/update/check?force=1' : '/api/update/check'
}
