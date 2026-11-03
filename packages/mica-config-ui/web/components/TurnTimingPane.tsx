import { useMemo } from 'react';
import { turnTimingStateFromRecord, type TurnTimingRecord } from '@packages/mica-common/turnTiming.js';
import { TurnTimingView, type TurnTimingRound } from './TurnTimingView.js';

/**
 * 会话详情里的「耗时」页签：读会话文件里落盘的最近若干轮。
 *
 * 数据跟着详情的头部一起来（`turnTimings`），不另外发请求：一份记录只有几千字节，
 * 而每次都要为它多开一条通道并不划算。运行中的那一轮还不在文件里——它由跑着这条
 * 会话的宿主在轮末落盘，页面这边如实说「没有记录」。
 */
export function TurnTimingPane({ timings }: { timings?: TurnTimingRecord[] }) {
  const rounds = useMemo<TurnTimingRound[]>(
    () =>
      (timings ?? []).map((record) => ({
        id: String(record.startedAt),
        state: turnTimingStateFromRecord(record),
      })),
    [timings],
  );
  return (
    <div className="timing-pane">
      <TurnTimingView
        rounds={rounds}
        emptyLabel="这条会话还没有耗时记录。跑完一轮之后，这里会按轮列出来（只保留最近 50 轮）。"
      />
    </div>
  );
}
