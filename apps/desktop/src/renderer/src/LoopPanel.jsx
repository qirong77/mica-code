import { useEffect, useMemo, useState } from 'react'
import { IconAlertCircle, IconChevronDown } from '@tabler/icons-react'
import {
  DEFAULT_LOOP_MINUTES,
  LOOP_INTERVAL_UNITS,
  loopDraftFromInterval,
  loopIntervalFromDraft,
  loopStatusLabel
} from './loop-command'

/**
 * 下一次触发的绝对时间。面板不会每秒重渲染，写相对倒计时会在打开几分钟后变成错的时间；
 * 跨天时补上日期，免得「下次 08:00」分不清是今天还是明天。
 */
function formatNextFire(nextFireAt) {
  const date = new Date(nextFireAt)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value) => String(value).padStart(2, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  return sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`
}

/**
 * 「会话设置 → 定时任务」的内容区：设置（或调整）当前会话的定时循环任务。
 *
 * 它就是 CLI `/loop <间隔> <任务>` 的可视化入口——提交后走同一条 `loops.start`，
 * 首轮立刻执行。已有循环时同一个面板变成编辑器（改间隔/内容、暂停、立即执行、停止）。
 *
 * 外壳由 `SessionSettingsDialog` 提供，这里只画表单与动作，不做定位。
 */
export function LoopPanel({
  loop = null,
  running = false,
  draft = '',
  onStart,
  onSetInterval,
  onSetTask,
  onPause,
  onResume,
  onStop,
  onFireNow
}) {
  const editing = Boolean(loop)
  const initial = useMemo(
    () =>
      editing
        ? loopDraftFromInterval(loop.intervalMs)
        : { amount: String(DEFAULT_LOOP_MINUTES), unit: 'm' },
    [editing, loop?.intervalMs]
  )
  const [amount, setAmount] = useState(initial.amount)
  const [unit, setUnit] = useState(initial.unit)
  // 新建时默认用输入框里已经写好的内容：用户先打了半句再点时钟图标，不该让他重打一遍。
  const [task, setTask] = useState(editing ? loop.task : String(draft || '').trim())
  const [error, setError] = useState('')

  useEffect(() => {
    setAmount(initial.amount)
    setUnit(initial.unit)
  }, [initial.amount, initial.unit])

  const parsed = loopIntervalFromDraft({ amount, unit })
  const trimmedTask = task.trim()
  const canSubmit = parsed.ok && Boolean(trimmedTask)

  const submit = () => {
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    if (!trimmedTask) {
      setError('请填写要定时执行的任务内容')
      return
    }
    setError('')
    if (editing) onSetInterval?.(parsed.intervalMs)
    if (editing) onSetTask?.(trimmedTask)
    else onStart?.({ intervalMs: parsed.intervalMs, task: trimmedTask })
  }

  return (
    <>
      <div className="chat-loop-form">
        <div className="chat-loop-field">
          <span className="chat-loop-label">触发间隔</span>
          <div className="chat-loop-row">
            <div className="chat-loop-interval">
              <input
                className="chat-loop-amount"
                value={amount}
                inputMode="numeric"
                aria-label="触发间隔"
                onChange={(event) => {
                  setAmount(event.target.value.replace(/[^\d.]/g, ''))
                  setError('')
                }}
              />
              <span className="chat-loop-unit">
                <select
                  value={unit}
                  aria-label="间隔单位"
                  onChange={(event) => setUnit(event.target.value)}
                >
                  {LOOP_INTERVAL_UNITS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <IconChevronDown size={11} aria-hidden="true" />
              </span>
            </div>
            <span className="chat-loop-every">
              {parsed.ok ? `每 ${parsed.label}发送一次` : '尚未设置有效间隔'}
            </span>
          </div>
        </div>

        <label className="chat-loop-field">
          <span className="chat-loop-label">任务内容</span>
          <textarea
            className="chat-loop-task"
            value={task}
            rows={3}
            aria-label="任务内容"
            placeholder="要定时执行的任务，例如：推荐一个 AI 新闻"
            onChange={(event) => {
              setTask(event.target.value)
              setError('')
            }}
          />
        </label>
      </div>

      {editing ? (
        <p className="chat-loop-status">
          <span
            className={`chat-loop-dot${loop.status === 'active' ? ' chat-loop-dot-active' : ' chat-loop-dot-paused'}${running ? ' chat-loop-dot-running' : ''}`}
            aria-hidden="true"
          />
          {loopStatusLabel(loop, running)}
          <span className="chat-loop-status-sep">·</span>
          已执行 {loop.fireCount || 0} 次
          {loop.status === 'active' && !running && loop.nextFireAt ? (
            <>
              <span className="chat-loop-status-sep">·</span>
              下次 {formatNextFire(loop.nextFireAt)}
            </>
          ) : null}
        </p>
      ) : (
        <p className="session-settings-note">
          按间隔自动把上面的任务内容发给当前会话，首轮立即执行。
        </p>
      )}

      {error ? (
        <p className="chat-loop-error">
          <IconAlertCircle size={11} /> {error}
        </p>
      ) : null}
      {editing && loop.lastError ? (
        <p className="chat-loop-error">
          <IconAlertCircle size={11} /> 上次：{loop.lastError}
        </p>
      ) : null}

      <div className="session-settings-actions">
        {editing ? (
          <button type="button" className="session-action" onClick={() => onFireNow?.()}>
            立即执行
          </button>
        ) : null}
        {editing ? (
          loop.status === 'active' ? (
            <button type="button" className="session-action" onClick={() => onPause?.()}>
              暂停
            </button>
          ) : (
            <button type="button" className="session-action" onClick={() => onResume?.()}>
              继续
            </button>
          )
        ) : null}
        {editing ? (
          <button
            type="button"
            className="session-action session-action-danger"
            onClick={() => onStop?.()}
          >
            停止
          </button>
        ) : null}
        <span className="session-settings-actions-spacer" />
        <button
          type="button"
          className="session-action session-action-primary"
          disabled={!canSubmit}
          onClick={submit}
        >
          {editing ? '保存' : '开始循环'}
        </button>
      </div>
    </>
  )
}
