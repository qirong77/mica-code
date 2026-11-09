import { CollapsiblePanel } from '@mica-config-ui/web'

export function DigestNotice({ children }) {
  return (
    <section className="chat-digest-notice" aria-label="长回复摘要">
      <CollapsiblePanel
        title="长回复摘要"
        meta={<span className="chat-digest-meta">自动整理</span>}
        defaultOpen
      >
        {children}
      </CollapsiblePanel>
    </section>
  )
}
