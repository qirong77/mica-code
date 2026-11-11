import { CollapsiblePanel } from '@mica-config-ui/web'

export function DigestNotice({ children, status }) {
  const running = status === 'running'
  return (
    <section className="chat-digest-notice" aria-label="长回复摘要" aria-busy={running}>
      <CollapsiblePanel
        title="长回复摘要"
        meta={
          <span className={`chat-digest-meta${running ? ' is-running' : ''}`} role="status">
            {running
              ? '正在整理'
              : status === 'warning' || status === 'error'
                ? '未生成'
                : '自动整理'}
          </span>
        }
        defaultOpen
      >
        {running ? <p className="chat-digest-pending">正在提炼回复要点…</p> : children}
      </CollapsiblePanel>
    </section>
  )
}
