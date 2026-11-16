import { IconDownload, IconRefresh } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArcoAction } from '@mica-config-ui/web'
import { ModalShell } from './chat-modal.jsx'
import {
  nativeStatusFromResult,
  preserveNativeStatus,
  runNativeUpdate,
  updateButtonState,
  updateCheckUrl
} from './app-update.js'
import { notify } from './notify.js'

const POLL_MS = 10 * 60 * 1000
const UPDATE_NOTICE_KEY = 'app-update-action'

async function readRemoteUpdate(force = false) {
  const response = await fetch(updateCheckUrl(force), { cache: 'no-store' })
  if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}）`)
  return response.json()
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error || '未知错误')
}

function externalUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null
  return value
}

function updateLinks(remote) {
  const entries = [
    [remote?.latestUrl, '打开最新提交'],
    [remote?.repository, '打开项目仓库']
  ]
  const seen = new Set()
  return entries.flatMap(([href, label]) => {
    const safe = externalUrl(href)
    if (!safe || seen.has(safe)) return []
    seen.add(safe)
    return [{ href: safe, label }]
  })
}

function nativeFailureMessage(result) {
  const blockers = Array.isArray(result?.blockers)
    ? result.blockers.map((item) => item?.label).filter(Boolean).join('；')
    : ''
  if (result?.code === 'busy') return `当前仍有工作在运行，更新包已保留。${blockers ? ` ${blockers}` : ''}`
  if (result?.code === 'activity-unavailable') return result.error || '无法确认当前工作状态，暂不重启更新。'
  if (result?.code === 'cancelled') return '已取消重启，更新包仍保留。'
  if (result?.code === 'unsupported') return '当前是源码 / 开发模式，没有可下载安装的桌面包。'
  if (result?.code === 'remote-window') return '当前页面是远程会话，不能安装本机应用，请切回本机窗口。'
  return result?.error || '更新操作没有完成。'
}

function UpdateDetails({ details, onClose }) {
  if (!details) return null
  return (
    <ModalShell title={details.title || '应用更新'} subtitle={details.mode} onClose={onClose}>
      <div className="space-y-3 text-xs leading-5 text-fg-strong">
        <div className="whitespace-pre-wrap break-words">{details.detail}</div>
        {details.links?.length ? (
          <div className="flex flex-col gap-1">
            <div className="text-fg-muted">直达链接</div>
            {details.links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="w-fit text-accent underline underline-offset-2 hover:text-accent-hover"
              >
                {link.label} ↗
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </ModalShell>
  )
}

export function AppUpdateAction() {
  const [remote, setRemote] = useState(null)
  const [native, setNative] = useState(null)
  const [busy, setBusy] = useState(false)
  const [details, setDetails] = useState(null)
  const bridge = typeof window !== 'undefined' ? window.micaClient?.appUpdate : null

  const setNativeStatus = useCallback((next) => {
    if (!next || typeof next.status !== 'string') return
    setNative((current) => preserveNativeStatus(current, next))
  }, [])

  const readNativeStatus = useCallback(async () => {
    if (typeof bridge?.status !== 'function') return null
    try {
      const result = await bridge.status()
      if (result?.ok === false) return result
      const status = nativeStatusFromResult(result)
      if (status) setNativeStatus(status)
      return result
    } catch {
      // Background status reads are best effort. A foreground click reports the
      // rejection instead of turning it into a silent no-op.
      return null
    }
  }, [bridge, setNativeStatus])

  const check = useCallback(
    async (force = false) => {
      try {
        const value = await readRemoteUpdate(force)
        if (value?.ok) setRemote(value)
      } catch {
        // Background source polling is auxiliary and must not toast every 10 minutes.
      }
      // Do not call check() here: polling must not reset an in-progress or already
      // downloaded native package. The native controller's status() is read-only.
      await readNativeStatus()
    },
    [readNativeStatus]
  )

  useEffect(() => {
    void check()
    const timer = window.setInterval(() => void check(), POLL_MS)
    const onVisible = () => {
      if (!document.hidden) void check(true)
    }
    document.addEventListener('visibilitychange', onVisible)
    const unsubscribe = bridge?.onStatus?.((status) => {
      setNativeStatus(status)
      if (status?.status === 'downloaded' && status.error) {
        notify({ key: UPDATE_NOTICE_KEY, text: '更新未能完成，安装包已保留', detail: status.error, level: 'error', timeout: 6000 })
      }
    })
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      unsubscribe?.()
    }
  }, [bridge, check, setNativeStatus])

  const button = useMemo(() => updateButtonState(remote, native), [remote, native])

  const showDetails = useCallback(
    ({ title, mode, detail, result = null }) => {
      setDetails({ title, mode, detail, links: updateLinks(remote), result })
    },
    [remote]
  )

  const reportNativeFailure = useCallback(
    (result) => {
      const detail = nativeFailureMessage(result)
      const code = result?.code
      const level = code === 'cancelled' ? 'info' : code === 'busy' ? 'warning' : 'error'
      notify({
        key: UPDATE_NOTICE_KEY,
        text:
          code === 'busy'
            ? '当前有工作运行，暂不重启更新'
            : code === 'activity-unavailable'
              ? '无法确认工作状态，暂不重启'
              : code === 'cancelled'
                ? '已取消重启更新'
                : '更新操作失败',
        detail,
        level,
        timeout: code === 'busy' ? 7000 : 5500
      })
      showDetails({ title: '更新没有完成', mode: '本机安装器', detail, result })
    },
    [showDetails]
  )

  const reportSourceOnly = useCallback(
    (outcome) => {
      const reason = outcome?.reason
      const result = outcome?.result
      const mode = reason === 'browser' ? '浏览器页面' : reason === 'remote-window' ? '远程页面' : reason === 'unsupported' ? '源码 / 开发模式' : '仅源码提交更新'
      const detail =
        reason === 'browser'
          ? '浏览器页面不能调用桌面安装器，也不会替远程服务安装或重启。可以查看下面的版本链接，服务更新仍走它自己的部署流程。'
          : reason === 'remote-window'
          ? nativeFailureMessage(result || { code: 'remote-window' })
          : reason === 'unsupported'
            ? '当前运行的是源码 / 开发模式，不能安装桌面更新。下面只提供提交链接，不会伪称可以下载安装。'
            : '已检查本机安装包，但当前没有可下载安装的桌面包。本次看到的是源码提交领先，下面提供提交链接。'
      notify({ key: UPDATE_NOTICE_KEY, text: '当前没有可下载安装的桌面包', detail, level: 'info', timeout: 6500 })
      showDetails({ title: '更新说明', mode, detail, result })
    },
    [showDetails]
  )

  const onClick = async () => {
    if (busy) return
    setBusy(true)
    const currentStatus = native?.status
    if (currentStatus === 'downloaded') {
      notify({ key: UPDATE_NOTICE_KEY, text: '正在确认工作状态…', detail: '更新包已下载，不会丢失。', level: 'info', timeout: 0 })
    } else if (currentStatus === 'available') {
      notify({ key: UPDATE_NOTICE_KEY, text: '正在下载更新…', level: 'info', timeout: 0 })
    } else {
      notify({ key: UPDATE_NOTICE_KEY, text: '正在检查本机更新…', level: 'info', timeout: 0 })
    }
    try {
      const outcome = await runNativeUpdate({
        bridge,
        currentStatus,
        onStatus: (status) => {
          setNativeStatus(status)
          if (status.status === 'checking') {
            notify({ key: UPDATE_NOTICE_KEY, text: '正在检查本机更新…', level: 'info', timeout: 0 })
          } else if (status.status === 'downloading') {
            const progress = Number.isFinite(status.progress) ? ` ${Math.round(status.progress)}%` : ''
            notify({ key: UPDATE_NOTICE_KEY, text: `正在下载更新…${progress}`, level: 'info', timeout: 0 })
          }
        }
      })
      if (outcome.kind === 'source') {
        reportSourceOnly(outcome)
      } else if (outcome.kind === 'error' || outcome.result?.ok === false) {
        reportNativeFailure(outcome.result || { ok: false, error: '更新操作没有完成' })
      } else if (outcome.kind === 'download') {
        const downloaded = outcome.status?.status === 'downloaded'
        notify({
          key: UPDATE_NOTICE_KEY,
          text: downloaded ? '更新包已下载' : '更新正在下载',
          detail: downloaded ? '准备好后点击「重启更新」，会先检查当前运行中的工作。' : '下载完成后会保留「重启更新」入口。',
          level: 'success',
          timeout: 6500
        })
      } else if (outcome.kind === 'install') {
        notify({ key: UPDATE_NOTICE_KEY, text: '正在重启并安装更新…', level: 'info', timeout: 0 })
      } else if (outcome.kind === 'pending') {
        notify({ key: UPDATE_NOTICE_KEY, text: '更新已在进行中', detail: '请等待当前检查或下载完成。', level: 'info', timeout: 4500 })
      }
    } catch (error) {
      // Keep this guard even though runNativeUpdate converts IPC rejection: a
      // bridge implementation can still throw outside its method call.
      const result = { ok: false, error: errorText(error) }
      reportNativeFailure(result)
    } finally {
      setBusy(false)
    }
  }

  if (!button.visible) {
    // A foreground click may discover that a transient native error has
    // cleared. Keep the explanation modal mounted for that click instead of
    // making the feedback disappear together with the footer action.
    return <UpdateDetails details={details} onClose={() => setDetails(null)} />
  }

  return (
    <>
      <ArcoAction
        type="button"
        title={native?.error || remote?.latestMessage || '发现 Mica 新版本'}
        aria-label={button.label}
        className="-ml-1.5 flex h-full shrink-0 items-center gap-1 px-1.5 text-accent hover:text-accent-hover"
        disabled={busy || native?.status === 'downloading' || native?.status === 'checking' || native?.status === 'installing'}
        onClick={onClick}
      >
        {native?.status === 'downloaded' ? <IconRefresh size={13} /> : <IconDownload size={13} />}
        <span>{button.label}</span>
      </ArcoAction>
      <UpdateDetails details={details} onClose={() => setDetails(null)} />
    </>
  )
}
