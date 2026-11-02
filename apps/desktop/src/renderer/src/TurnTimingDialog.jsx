import { useState } from 'react'
import { IconChevronRight, IconStopwatch } from '@tabler/icons-react'
import { ModalMeta, ModalShell } from './chat-modal'
import { formatLogElapsed } from './chat-tool-display'
import { groupPercents } from './turn-timing'

/**
 * 输入框旁「耗时分析」弹窗：最近一轮的时间都花在哪。
 *
 * 只呈现 `turn-timing.js` 聚合出的东西——等待模型 / 模型输出 / 工具调用三类顺序固定
 * （便于跨轮对比），点开某一类按**发生顺序**看每一次的明细。数据只来自本轮的事件流：
 * host 还留着本轮事件时重载页面也看得到，切到没有本轮事件的会话就只剩空态。
 */

const GROUP_HINTS = {
  wait: '请求发出到第一个 token 之前',
  generate: '流式输出正文与思考',
  tool: '工具调用到结果返回'
}

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

function percentText(group, percent) {
  if (!group.count) return '—'
  // 小于 1% 的段也别显示成 0%（那一类明明花了时间），取整会误导。
  if (group.ratio > 0 && group.ratio * 100 < 1) return '<1%'
  return `${percent}%`
}

function offsetText(ms) {
  return `+${formatLogElapsed(ms)}`
}

function itemLabel(groupId, item) {
  if (groupId === 'wait') {
    if (item.live) return '正在等下一次请求'
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
function TimingBar({ groups }) {
  const segments = []
  for (const group of groups) {
    for (const item of group.items) {
      if (item.durationMs <= 0) continue
      segments.push({
        id: group.id,
        label: group.label,
        durationMs: item.durationMs,
        start: item.start
      })
    }
  }
  if (!segments.length) return null
  const total = segments.reduce((sum, segment) => sum + segment.durationMs, 0)
  // 按真实发生顺序铺：等待与工具一轮里来回交替，按类聚合会把两段等待连成一条，
  // 看起来像「一直在等」。
  segments.sort((a, b) => a.start - b.start)
  return (
    <div className="chat-timing-bar" aria-hidden="true">
      {segments.map((segment, index) => (
        <span
          key={index}
          className={`chat-timing-bar-seg is-${segment.id}`}
          title={`${segment.label} ${formatLogElapsed(segment.durationMs)}`}
          style={{ width: `${(segment.durationMs / total) * 100}%` }}
        />
      ))}
    </div>
  )
}

export function TurnTimingDialog({ timing, onClose }) {
  // 默认展开最费时间的那一类：这一轮被谁占着是打开它的第一个问题，
  // 其余两类保持紧凑，需要时再点开。
  const [openGroups, setOpenGroups] = useState(() => {
    const heaviest = [...timing.groups].sort((a, b) => b.totalMs - a.totalMs)[0]
    return new Set(heaviest && heaviest.count > 0 ? [heaviest.id] : [])
  })

  const toggle = (id) => {
    setOpenGroups((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const percents = groupPercents(timing.groups)

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
      <TimingBar groups={timing.groups} />
      <div className="chat-timing-list">
        {timing.groups.map((group, groupIndex) => {
          const expanded = openGroups.has(group.id)
          const empty = group.count === 0
          return (
            <div className="chat-timing-group" key={group.id}>
              <button
                type="button"
                className={`chat-timing-row${expanded && !empty ? ' is-open' : ''}`}
                onClick={() => !empty && toggle(group.id)}
                disabled={empty}
                aria-expanded={!empty && expanded}
              >
                <span className={`chat-timing-dot is-${group.id}`} aria-hidden="true" />
                <span className="chat-timing-name">
                  {group.label}
                  <span className="chat-timing-hint">{GROUP_HINTS[group.id]}</span>
                </span>
                <span className="chat-timing-count">
                  {group.count > 0 ? `${group.count} 次` : '—'}
                </span>
                <span className="chat-timing-ms">
                  {group.count > 0 ? formatLogElapsed(group.totalMs) : '—'}
                </span>
                <span className="chat-timing-ratio">
                  {percentText(group, percents[groupIndex])}
                </span>
                <IconChevronRight
                  size={12}
                  className="chat-timing-chevron"
                  style={{ visibility: empty ? 'hidden' : 'visible' }}
                />
              </button>
              {expanded && !empty ? (
                <ul className="chat-timing-items">
                  {group.items.map((item, index) => {
                    const badge = itemStatusLabel(group.id, item)
                    return (
                      <li className="chat-timing-item" key={index}>
                        <span className="chat-timing-offset">{offsetText(item.offsetMs)}</span>
                        <span className="chat-timing-item-label" title={itemLabel(group.id, item)}>
                          {itemLabel(group.id, item)}
                        </span>
                        {badge ? (
                          <span className={`chat-timing-badge is-${item.status}`}>{badge}</span>
                        ) : null}
                        <span className="chat-timing-ms">{formatLogElapsed(item.durationMs)}</span>
                      </li>
                    )
                  })}
                </ul>
              ) : null}
            </div>
          )
        })}
      </div>
      <div className="chat-timing-note">
        只记录最近一轮；时间来自本轮的事件流，按「等模型 / 输出 / 跑工具」首尾相接切分。
      </div>
    </ModalShell>
  )
}
