import { IconDownload, IconInfoCircle, IconRefresh } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArcoAction } from '@mica-config-ui/web'
import { ModalShell } from './chat-modal.jsx'
import {
  nativeStatusFromResult,
  nativeFailureMessage,
  mergeNativeStatus,
  runNativeUpdate,
  sourceUpdateDetails,
  updateButtonState,
  updateCheckUrl,
  updateLinks
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

function UpdateDetails({ details, onClose }) {
  if (!details) return null
  return (
    <ModalShell title={details.title || '应用更新'} subtitle={details.mode} onClose={onClose}>
      <div className="space-y-3 text-xs leading-5 text-fg-strong">
        <div className="whitespace-pre-wrap break-words">{details.detail}</div>
        {details.diagnostic ? (
          <div className="text-fg-muted">
            <div>诊断信息</div>
            <div className="whitespace-pre-wrap break-words">{details.diagnostic}</div>
          </div>
        ) : null}
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

  const setNativeStatus = useCallback((next, { force = false } = {}) => {
    if (!next || typeof next.status !== 'string') return
    setNative((current) => mergeNativeStatus(current, next, { force }))
  }, [])

  const readNativeStatus = useCallback(async () => {
    if (typeof bridge?.status !== 'function') return null
    try {
      const result = await bridge.status()
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
        notify({
          key: UPDATE_NOTICE_KEY,
          text: '更新未能完成，安装包已保留',
          detail: status.message || status.error,
          level: 'error',
          timeout: 6000
        })
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
    ({ title, mode, detail, result = null, reason = null }) => {
      const status = nativeStatusFromResult(result)
      const errors = [...new Set([result?.error, status?.error].filter(Boolean).map(errorText))]
      const diagnostic = [
        reason || status?.reason ? `原因：${reason || status.reason}` : null,
        ...errors.filter((error) => !detail.includes(error)).map((error) => `原始错误：${error}`)
      ]
        .filter(Boolean)
        .join('\n')
      setDetails({ title, mode, detail, diagnostic, links: updateLinks(remote), result })
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
      const { mode, detail } = sourceUpdateDetails(outcome)
      notify({
        key: UPDATE_NOTICE_KEY,
        text: '当前不提供自动下载安装',
        detail,
        level: 'info',
        timeout: 6500
      })
      showDetails({
        title: '更新说明',
        mode,
        detail,
        result: outcome?.result,
        reason: outcome?.reason
      })
    },
    [showDetails]
  )

  const onClick = async () => {
    if (busy) return
    setBusy(true)
    const currentStatus = native?.status
    if (currentStatus === 'downloaded') {
      notify({
        key: UPDATE_NOTICE_KEY,
        text: '正在确认工作状态…',
        detail: '更新包已下载，不会丢失。',
        level: 'info',
        timeout: 0
      })
    } else if (currentStatus === 'available') {
      notify({ key: UPDATE_NOTICE_KEY, text: '正在下载更新…', level: 'info', timeout: 0 })
    } else {
      notify({ key: UPDATE_NOTICE_KEY, text: '正在检查本机更新…', level: 'info', timeout: 0 })
    }
    try {
      const outcome = await runNativeUpdate({
        bridge,
        currentStatus,
        onStatus: (status, meta) => {
          setNativeStatus(status, { force: meta?.final === true })
          if (status.status === 'checking') {
            notify({ key: UPDATE_NOTICE_KEY, text: '正在检查本机更新…', level: 'info', timeout: 0 })
          } else if (status.status === 'downloading') {
            const progress = Number.isFinite(status.progress)
              ? ` ${Math.round(status.progress)}%`
              : ''
            notify({
              key: UPDATE_NOTICE_KEY,
              text: `正在下载更新…${progress}`,
              level: 'info',
              timeout: 0
            })
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
          detail: downloaded
            ? '准备好后点击「重启更新」，会先检查当前运行中的工作。'
            : '下载完成后会保留「重启更新」入口。',
          level: 'success',
          timeout: 6500
        })
      } else if (outcome.kind === 'install') {
        notify({ key: UPDATE_NOTICE_KEY, text: '正在重启并安装更新…', level: 'info', timeout: 0 })
      } else if (outcome.kind === 'pending') {
        notify({
          key: UPDATE_NOTICE_KEY,
          text: '更新已在进行中',
          detail: '请等待当前检查或下载完成。',
          level: 'info',
          timeout: 4500
        })
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
        title={
          native?.message ||
          native?.error ||
          (button.label === '有新提交'
            ? remote?.latestMessage || '发现新的源码提交，不代表已发布桌面安装包'
            : '查看 Mica 更新状态与下载说明')
        }
        aria-label={button.label}
        className="-ml-1.5 flex h-full shrink-0 items-center gap-1 px-1.5 text-accent hover:text-accent-hover"
        disabled={
          busy ||
          native?.status === 'downloading' ||
          native?.status === 'checking' ||
          native?.status === 'installing'
        }
        onClick={onClick}
      >
        {native?.status === 'downloaded' ? (
          <IconRefresh size={13} />
        ) : ['available', 'downloading'].includes(native?.status) ? (
          <IconDownload size={13} />
        ) : (
          <IconInfoCircle size={13} />
        )}
        <span>{button.label}</span>
      </ArcoAction>
      <UpdateDetails details={details} onClose={() => setDetails(null)} />
    </>
  )
}
