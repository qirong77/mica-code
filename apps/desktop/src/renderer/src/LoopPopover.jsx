import { useEffect, useMemo, useState } from 'react'
import {
  IconAlertCircle,
  IconPlayerPause,
  IconPlayerPlay,
  IconSend,
  IconTrash
} from '@tabler/icons-react'
import {
  DEFAULT_LOOP_MINUTES,
  LOOP_INTERVAL_UNITS,
  formatLoopInterval,
  loopDraftFromInterval,
  loopIntervalFromDraft,
  loopProgressLabel,
  loopStatusLabel
} from './loop-command'
import { Popover } from './Popover'

/**
 * 输入框右侧时钟图标的面板：设置（或调整）当前会话的定时循环任务。
 *
 * 它就是 CLI `/loop <间隔> <任务>` 的可视化入口——提交后走同一条 `loops.start`，
 * 首轮立刻执行。已有循环时同一个面板变成编辑器（改间隔/内容、暂停、立即执行、停止）。
 *
 * 浮层外壳（尺寸、关闭时机）在 `Popover.jsx`，与模型选择、自动压缩共用同一套。
 */
export function LoopPopover({
  loop = null,
  draft = '',
  onStart,
  onSetInterval,
  onSetTask,
  onPause,
  onResume,
  onStop,
  onFireNow,
  onClose
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
    <Popover
      name="loop"
      title="定时任务"
      icon={<span aria-hidden="true">⏰</span>}
      onClose={onClose}
      meta={
        editing ? `${loopStatusLabel(loop)} · ${loopProgressLabel(loop)}` : '在该会话按间隔自动发送'
      }
      actions={
        <>
          {editing && (
            <button
              type="button"
              className="chat-popover-icon"
              title="立即执行一次"
              aria-label="立即执行一次"
              onClick={() => onFireNow?.()}
            >
              <IconSend size={14} />
            </button>
          )}
          {editing &&
            (loop.status === 'active' ? (
              <button
                type="button"
                className="chat-popover-icon"
                title="暂停"
                aria-label="暂停"
                onClick={() => onPause?.()}
              >
                <IconPlayerPause size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="chat-popover-icon"
                title="继续"
                aria-label="继续"
                onClick={() => onResume?.()}
              >
                <IconPlayerPlay size={14} />
              </button>
            ))}
          {editing && (
            <button
              type="button"
              className="chat-popover-icon chat-popover-danger"
              title="停止定时任务"
              aria-label="停止定时任务"
              onClick={() => onStop?.()}
            >
              <IconTrash size={14} />
            </button>
          )}
          <button type="button" className="chat-loop-create" disabled={!canSubmit} onClick={submit}>
            {editing ? '保存修改' : '开始定时循环'}
          </button>
        </>
      }
    >
      <div className="chat-loop-form">
        <label className="chat-loop-field">
          每隔
          <input
            value={amount}
            inputMode="numeric"
            aria-label="触发间隔"
            onChange={(event) => {
              setAmount(event.target.value.replace(/[^\d.]/g, ''))
              setError('')
            }}
          />
          <select
            className="chat-loop-unit"
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
          自动发送
        </label>
      </div>

      <textarea
        className="chat-loop-task"
        value={task}
        rows={2}
        aria-label="任务内容"
        placeholder="要定时执行的任务，例如：推荐一个 AI 新闻"
        onChange={(event) => {
          setTask(event.target.value)
          setError('')
        }}
      />

      {error ? (
        <p className="chat-loop-error">
          <IconAlertCircle size={11} /> {error}
        </p>
      ) : (
        <p className="chat-loop-preview">
          <span className="chat-loop-preview-label">{editing ? '任务：' : '将发送：'}</span>
          {trimmedTask || '（填写任务内容）'}
          {parsed.ok ? ` · 每 ${parsed.label}` : ''}
        </p>
      )}

      {editing && loop.lastError ? (
        <p className="chat-loop-error">
          <IconAlertCircle size={11} /> 上次：{loop.lastError}
        </p>
      ) : null}
      {editing && parsed.ok ? (
        <p className="chat-loop-hint">
          保存后：每 {formatLoopInterval(parsed.intervalMs)} 执行一次
        </p>
      ) : null}
    </Popover>
  )
}
