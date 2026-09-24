import { useCallback, useEffect, useState } from 'react'
import {
  IconClock,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconTrash,
  IconX
} from '@tabler/icons-react'
import {
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_RUNS,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  countdownLabel,
  formatIntervalMinutes,
  parseScheduleDraft,
  taskProgress,
  taskStatusLabel
} from './chat-schedule'

/**
 * 输入框右侧那个时钟图标点开的面板：给「当前这条对话」设置定时任务。
 *
 * 消息正文直接取输入框里还没发出去的内容（定时任务就是替用户按回车），所以这里不再放
 * 一个正文输入框——那样会和草稿状态分叉。任务活在运行时里（页签关掉也会继续跑），
 * 因此面板只是「看一眼 + 改 / 停 / 删」的视图，所有变更都过 IPC 并由广播回到这里。
 *
 * 面板绝对定位浮在输入框上方（与 `@` 补全浮层同一套定位与层级），所以宽度按视口夹住、
 * 不参与对话区布局。
 */
export function SchedulePopover({
  tasks = [],
  sessionId,
  sessionTitle,
  draftText,
  onChanged,
  onClose,
  onNotice
}) {
  const [intervalMinutes, setIntervalMinutes] = useState(String(DEFAULT_INTERVAL_MINUTES))
  const [runs, setRuns] = useState(String(DEFAULT_RUNS))
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // 倒计时每秒走一格；面板本身开着的时间很短，开销可以忽略。
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const onKeyDown = (event) => event.key === 'Escape' && onClose?.()
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const run = useCallback(
    (promise, { onOk } = {}) => {
      setBusy(true)
      setError(null)
      return promise
        .then((result) => {
          if (!result?.ok) {
            setError(result?.error || '操作失败')
            return null
          }
          onChanged?.(result.tasks)
          onOk?.(result)
          return result
        })
        .catch((failure) => {
          setError(failure instanceof Error ? failure.message : String(failure))
          return null
        })
        .finally(() => setBusy(false))
    },
    [onChanged]
  )

  const create = () => {
    const parsed = parseScheduleDraft({ intervalMinutes, runs })
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    const prompt = String(draftText || '').trim()
    if (!prompt) {
      setError('输入框里还没有要定时发送的内容')
      return
    }
    if (!sessionId) {
      setError('这条对话还没有关联会话，先发送一条消息再设置')
      return
    }
    void run(
      window.mica.schedule.create({
        sessionId,
        title: sessionTitle || null,
        prompt,
        intervalMinutes: parsed.intervalMinutes,
        totalRuns: parsed.totalRuns
      }),
      {
        onOk: (result) => {
          const task = result.task
          onNotice?.(
            `已创建定时任务：每 ${formatIntervalMinutes(parsed.intervalMinutes)} 发送一次${
              parsed.totalRuns > 0 ? `，共 ${parsed.totalRuns} 次` : '（不限次）'
            }`
          )
          if (task) setError(null)
        }
      }
    )
  }

  const draftPreview = String(draftText || '').trim()

  return (
    <div className="chat-schedule-panel" role="dialog" aria-label="定时任务">
      <div className="chat-schedule-head">
        <IconClock size={13} />
        <span className="chat-schedule-title">定时任务</span>
        <span
          className="chat-schedule-sub"
          title={sessionTitle ? `会话：${sessionTitle}` : undefined}
        >
          在当前对话中按间隔自动发送
        </span>
        <button type="button" className="chat-schedule-close" aria-label="关闭" onClick={onClose}>
          <IconX size={13} />
        </button>
      </div>

      <div className="chat-schedule-form">
        <label className="chat-schedule-field">
          <span>每隔</span>
          <input
            type="number"
            min={MIN_INTERVAL_MINUTES}
            max={MAX_INTERVAL_MINUTES}
            step={1}
            value={intervalMinutes}
            onChange={(event) => setIntervalMinutes(event.target.value)}
          />
          <span className="chat-schedule-unit">分钟</span>
        </label>
        <label className="chat-schedule-field">
          <span>发送</span>
          <input
            type="number"
            min={1}
            step={1}
            placeholder="不限"
            value={runs}
            onChange={(event) => setRuns(event.target.value)}
          />
          <span className="chat-schedule-unit">次（留空 = 不限）</span>
        </label>
        <button
          type="button"
          className="chat-schedule-create"
          disabled={busy || !draftPreview || !sessionId}
          onClick={create}
        >
          {busy ? '处理中…' : '创建定时任务'}
        </button>
      </div>

      <p className="chat-schedule-preview" title={draftPreview || undefined}>
        {draftPreview ? (
          <>
            <span className="chat-schedule-preview-label">将发送：</span>
            {draftPreview}
          </>
        ) : (
          '输入框为空 —— 定时任务发送的就是输入框里的内容。'
        )}
      </p>

      {error && <p className="chat-schedule-error">{error}</p>}

      {tasks.length > 0 && (
        <div className="chat-schedule-list">
          <div className="chat-schedule-list-title">这条对话的定时任务</div>
          {tasks.map((task) => (
            <div key={task.id} className={`chat-schedule-item chat-schedule-${task.status}`}>
              <span className={`chat-schedule-dot chat-schedule-dot-${task.status}`} />
              <span className="chat-schedule-item-main">
                <span className="chat-schedule-item-line" title={task.prompt}>
                  每 {formatIntervalMinutes(task.intervalMs / 60_000)} · {taskProgress(task)}
                </span>
                <span className="chat-schedule-item-meta">
                  {task.status === 'active'
                    ? countdownLabel(task.nextRunAt, now) || '等待触发'
                    : taskStatusLabel(task)}
                  {task.lastError ? ` · ${task.lastError}` : ''}
                </span>
              </span>
              <span className="chat-schedule-actions">
                {task.status === 'active' && (
                  <>
                    <button
                      type="button"
                      title="立即发送一次（消耗一次配额）"
                      aria-label="立即发送一次"
                      disabled={busy || !sessionId}
                      onClick={() =>
                        void run(window.mica.schedule.runNow(task.id), {
                          onOk: () => onNotice?.('已发送一轮定时消息')
                        })
                      }
                    >
                      <IconRefresh size={12} />
                    </button>
                    <button
                      type="button"
                      title="暂停"
                      aria-label="暂停定时任务"
                      disabled={busy}
                      onClick={() =>
                        void run(window.mica.schedule.update(task.id, { status: 'paused' }))
                      }
                    >
                      <IconPlayerPause size={12} />
                    </button>
                  </>
                )}
                {task.status === 'paused' && (
                  <button
                    type="button"
                    title="继续（从当前时间重新计时）"
                    aria-label="继续定时任务"
                    disabled={busy}
                    onClick={() =>
                      void run(window.mica.schedule.update(task.id, { status: 'active' }))
                    }
                  >
                    <IconPlayerPlay size={12} />
                  </button>
                )}
                <button
                  type="button"
                  title="删除定时任务"
                  aria-label="删除定时任务"
                  className="chat-schedule-danger"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm('确定删除这条定时任务？')) return
                    void run(window.mica.schedule.remove(task.id))
                  }}
                >
                  <IconTrash size={12} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
