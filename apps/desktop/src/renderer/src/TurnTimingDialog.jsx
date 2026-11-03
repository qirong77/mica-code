import { useEffect, useMemo, useState } from 'react'
import { IconStopwatch } from '@tabler/icons-react'
import { readSessionDetails, TurnTimingView } from '@mica-config-ui/web'
import { turnTimingStateFromRecord } from '@packages/mica-common/turnTiming.js'
import { ModalMeta, ModalShell } from './chat-modal'

/**
 * 时间去哪了：这条会话最近几轮 + 正在跑的这一轮。
 *
 * 视图本身（合计条、图例、工具排行、顺序明细）与会话详情的「耗时」页签是同一个
 * 组件（`@mica-config-ui/web` 的 `TurnTimingView`），这里只负责取数：落盘的记录读
 * 会话详情（最新一轮在轮末才写盘，所以运行中那一轮由 ChatView 现场传进来）。
 */
export function TurnTimingDialog({ sessionId, liveRound, now, onClose }) {
  const [records, setRecords] = useState(null)
  const [error, setError] = useState('')
  // 这一轮刚跑完时落盘记录才出现（宿主在轮末写），重新读一次，别让弹窗空着。
  const live = Boolean(liveRound)

  useEffect(() => {
    let alive = true
    if (!sessionId) {
      setRecords([])
      return () => {
        alive = false
      }
    }
    readSessionDetails(sessionId)
      .then((details) => {
        if (alive) setRecords(details?.turnTimings || [])
      })
      .catch((loadError) => {
        if (!alive) return
        setError(loadError?.message || '读不到这条会话的耗时记录')
        setRecords([])
      })
    return () => {
      alive = false
    }
  }, [live, sessionId])

  const rounds = useMemo(() => {
    const saved = (records || []).map((record) => ({
      id: String(record.startedAt),
      state: turnTimingStateFromRecord(record)
    }))
    // 运行中的那一轮还没落盘，接在落盘记录后面（它就是最新的一轮）。
    return liveRound ? [...saved, liveRound] : saved
  }, [liveRound, records])

  const loading = records === null
  return (
    <ModalShell
      title="耗时分析"
      icon={<IconStopwatch size={14} />}
      subtitle="每一轮的时间都切成了等待模型 / 模型输出 / 工具执行"
      className="chat-modal-timing"
      onClose={onClose}
      meta={
        <ModalMeta
          items={[
            loading ? '正在读取…' : rounds.length ? `最近 ${rounds.length} 轮` : '还没有记录',
            '会话里保留最近 50 轮'
          ]}
        />
      }
    >
      {error ? <div className="chat-timing-error">{error}</div> : null}
      <div className="mica-config-ui is-embed">
        <TurnTimingView
          rounds={rounds}
          now={now}
          emptyLabel={
            loading
              ? '正在读取这条会话的耗时记录…'
              : '还没有耗时记录：跑一轮之后这里会显示时间去了哪里。'
          }
        />
      </div>
    </ModalShell>
  )
}
