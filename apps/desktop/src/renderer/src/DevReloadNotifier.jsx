/**
 * 「构建完成，准备重载」的那条顶部通知（只在开发期出现——运行时没有构建 stamp 时状态恒为 idle）。
 *
 * 它自己不画界面：把运行时推来的状态翻成一条通知交给 `notify()`，外观、自动消失与
 * 排队都由 `NotificationHost` 统一管。这样这条提示不会比应用里其他提示长得不一样，
 * 也不需要为它单独维护一套浮层。
 *
 * 倒计时结束后的软停阶段（`draining`）照常显示：那时正在等每一轮走到下一次请求之前，
 * 最多 15s。它不会转成「要不要现在掐断」——这一轮已经注定被换掉，续跑是自动的。
 */
import { useEffect, useRef, useState } from 'react'
import { dismissNotification, notify, queueAfterReload } from './notify'

const NOTICE_KEY = 'dev-reload'
const RETRY_KEY = 'dev-reload:retry'
/** 页面还在 = 这次刷新没发生。留一点余量让 reload 自己先走完。 */
const RETRY_CHECK_MS = 3500

const LEVEL_LABELS = {
  renderer: '界面',
  cli: '插件与工具',
  runtime: '运行时',
  shell: '应用外壳'
}

export function DevReloadNotifier() {
  // `initial` 标记「这条状态是挂载时问来的快照」还是「订阅推来的事件」：重载脉冲只有
  // 1.5s，刚刷完的页面几乎必然还能问到 `phase: 'reload'`——拿它当事件处理就会再刷一次，
  // 刷到脉冲结束为止。只有真的收到事件才动手。
  const [state, setState] = useState(null)
  // 已经为哪一份构建刷过。用 `builtAt` 而不是一个布尔值：某次刷新被拦下（页面里有
  // beforeunload）时布尔值会一直停在那儿，之后每次构建都被静默跳过。
  const handledRef = useRef(null)

  useEffect(() => {
    const api = window.mica?.devReload
    if (!api) return undefined
    let alive = true
    api
      .getState()
      .then((next) => {
        if (alive) setState({ ...next, initial: true })
      })
      .catch(() => {})
    const off = api.onState((next) => {
      if (alive) setState({ ...next, initial: false })
    })
    return () => {
      alive = false
      off?.()
    }
  }, [])

  useEffect(() => {
    const phase = state?.phase
    if (!state || !phase || phase === 'idle') {
      dismissNotification(NOTICE_KEY)
      return
    }
    if (phase === 'countdown') dismissNotification(RETRY_KEY)

    const label = LEVEL_LABELS[state.level] || '产物'
    const seconds = Math.max(0, Math.ceil((state.remainingMs || 0) / 1000))
    const busy = state.busyHosts || 0
    // 正文已经说了是哪一层（「界面有更新」），说明行只列**其余**变了的层；
    // 直接把 `renderer` 这种内部名字打出来是给开发者看的噪音。
    const changed = (state.changed || [])
      .map((layer) => LEVEL_LABELS[layer] || layer)
      .filter((name) => name !== label)
      .join(' / ')

    let text = ''
    let level = 'info'
    if (phase === 'countdown') {
      text = `${label}有更新 · ${seconds}s 后重载`
    } else if (phase === 'draining') {
      text = busy > 0 ? `等 ${busy} 个会话停在下一次请求前，最多 15s · 之后自动继续` : '正在收尾…'
    } else if (phase === 'applying') {
      text = '正在重启会话宿主 · 重启后自动继续'
    } else if (phase === 'reload') {
      text = '正在重载界面…'
    } else if (phase === 'restart') {
      text = '正在重启应用…'
      level = 'warning'
    }

    notify({
      key: NOTICE_KEY,
      level,
      text,
      detail: changed,
      timeout: 0,
      sticky: true,
      // 同一份构建反复推送时只更新文案，按钮引用保持稳定（宿主按 key 原地更新）。
      actions:
        phase === 'countdown'
          ? [
              {
                label: '稍后',
                variant: 'ghost',
                onClick: () => void window.mica?.devReload?.act('later')
              },
              {
                label: '立即重载',
                variant: 'primary',
                onClick: () => void window.mica?.devReload?.act('now')
              }
            ]
          : []
    })
  }, [state])

  // 运行时说了「可以重载」再重载：宿主已经腾空，此刻刷新不会打断任何一轮。
  useEffect(() => {
    if (state?.phase !== 'reload' || state.initial) return
    const builtAt = state.builtAt || ''
    if (handledRef.current === builtAt) return
    handledRef.current = builtAt

    // 页面一刷这条通知就没了，所以在刷之前留一句给新页面。
    queueAfterReload({
      level: 'success',
      text: '界面已更新',
      detail: (state.changed || []).join(' / '),
      timeout: 4000
    })
    // 这里**不能**在 effect 的清理函数里清定时器：运行时会把同一份状态推好几次，
    // 每次 setState 都会重跑这个 effect，清理一次就把还没到点的刷新取消了
    // （表现就是「倒计时结束、提示消失、页面没刷」）。去重交给上面的 builtAt。
    setTimeout(() => window.location.reload(), 400)
    // 兜底：刷新被拦住（页面里挂着 beforeunload 的脏文件）时不能一声不响地不刷，
    // 页面上得留一个能点的入口。页面真的刷掉了的话这两个定时器随文档一起消失。
    setTimeout(() => {
      dismissNotification(NOTICE_KEY)
      notify({
        key: RETRY_KEY,
        level: 'warning',
        text: '界面没有自动刷新',
        detail: '有未保存的编辑时会拦下刷新，先处理掉再试一次',
        timeout: 0,
        sticky: true,
        actions: [
          {
            label: '立即刷新',
            variant: 'primary',
            onClick: () => window.location.reload()
          }
        ]
      })
    }, RETRY_CHECK_MS)
  }, [state])

  return null
}
