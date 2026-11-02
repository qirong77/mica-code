import { IconStopwatch } from '@tabler/icons-react'
import { ModalMeta, ModalShell } from './chat-modal'
import { formatLogElapsed } from './chat-tool-display'

/** 最近一轮按发生顺序展示；概览条与明细共用同一条时间线。 */

const STATUS_LABEL = {
  completed: '已完成',
  error: '失败',
  aborted: '已中止'
}

function statusText(timing) {
  if (timing.running) return '进行中'
  return STATUS_LABEL[timing.outcome] || '已完成'
}

function statusClass(timing) {
  if (timing.running) return 'is-running'
  if (timing.outcome === 'error') return 'is-error'
  if (timing.outcome === 'aborted') return 'is-partial'
  return 'is-done'
}

function offsetText(ms) {
  return `+${formatLogElapsed(ms)}`
}

function itemLabel(groupId, item) {
  if (groupId === 'wait') {
    if (item.live) return '等待中'
    if (item.tail) return '收尾（本轮结束前）'
    return '等待首字'
  }
  if (groupId === 'generate') {
    return item.chars > 0 ? `输出 ${item.chars.toLocaleString()} 字符` : '输出'
  }
  return item.displayText || item.tool || '工具调用'
}

function itemStatusLabel(groupId, item) {
  if (groupId !== 'tool') return ''
  if (item.status === 'completed') return ''
  if (item.status === 'aborted') return '已中止'
  if (item.status === 'error') return '失败'
  return '进行中'
}

/** 占比条：按时间顺序铺开，一眼看出这一轮主要被谁占着。 */
function TimingBar({ segments }) {
  const total = segments.reduce((sum, segment) => sum + segment.durationMs, 0)
  if (!total) return null
  return (
    <div className="chat-timing-bar" aria-hidden="true">
      {segments.map((segment, index) => (
        <span
          key={index}
          className={`chat-timing-bar-seg is-${segment.kind}`}
          title={`${segment.label} ${formatLogElapsed(segment.durationMs)}`}
          style={{ flexGrow: segment.durationMs }}
        />
      ))}
    </div>
  )
}

export function TurnTimingDialog({ timing, onClose }) {
  return (
    <ModalShell
      title="本轮耗时"
      icon={<IconStopwatch size={14} />}
      subtitle={`${new Date(timing.startedAt).toLocaleTimeString()} 开始`}
      className="chat-modal-timing"
      onClose={onClose}
      meta={
        <ModalMeta
          items={[
            <span className={`chat-modal-status ${statusClass(timing)}`} key="status">
              {statusText(timing)}
            </span>,
            `总耗时 ${formatLogElapsed(timing.totalMs)}`,
            `${timing.requests} 次请求`,
            `${timing.toolCalls} 次工具调用`
          ]}
        />
      }
    >
      <TimingBar segments={timing.timeline} />
      <div className="chat-timing-columns" aria-hidden="true">
        <span>开始于</span>
        <span>执行过程 · 从上到下</span>
        <span>耗时</span>
      </div>
      <ol className="chat-timing-list" aria-label="按时间顺序的执行过程">
        {timing.timeline.map((item, index) => {
          const badge = itemStatusLabel(item.kind, item)
          const detail = itemLabel(item.kind, item)
          return (
            <li className="chat-timing-item" key={index}>
              <span className="chat-timing-offset">{offsetText(item.offsetMs)}</span>
              <span className="chat-timing-marker" aria-hidden="true">
                <span className={`chat-timing-dot is-${item.kind}`} />
              </span>
              <span className="chat-timing-content">
                <span className="chat-timing-name">{item.label}</span>
                <span className="chat-timing-item-label" title={detail}>
                  {detail}
                </span>
              </span>
              {badge ? (
                <span className={`chat-timing-badge is-${item.status}`}>{badge}</span>
              ) : null}
              <span className="chat-timing-ms">{formatLogElapsed(item.durationMs)}</span>
            </li>
          )
        })}
      </ol>
      <div className="chat-timing-note">
        只记录最近一轮；开始时间相对于本轮起点，按实际发生顺序展示。
      </div>
    </ModalShell>
  )
}
