import { SessionDetailView } from '@mica-config-ui/web'
import { ModalShell } from './chat-modal'

/** 与统计/设置共用上下文分析；仅在用户打开详情时加载整套详情面板。 */
export function ContextDetailDialog({ sessionId, onClose }) {
  return (
    <ModalShell bare onClose={onClose} className="chat-modal-session-detail">
      {sessionId ? (
        <div className="mica-config-ui is-embed session-detail-embed">
          <SessionDetailView sessionId={sessionId} defaultTab="context" />
        </div>
      ) : (
        <div className="chat-modal-empty">No active session</div>
      )}
    </ModalShell>
  )
}
