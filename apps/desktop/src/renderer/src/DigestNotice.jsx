import { useState } from 'react'
import { Button, CollapsiblePanel } from '@mica-config-ui/web'

export function DigestNoticeContent({ text, fullText, renderMarkdown }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <DigestNoticeContentView
      text={text}
      fullText={fullText}
      renderMarkdown={renderMarkdown}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    />
  )
}

export function DigestNoticeContentView({ text, fullText, renderMarkdown, expanded, onToggle }) {
  const canExpand = typeof fullText === 'string' && fullText !== text
  return (
    <>
      {renderMarkdown(canExpand && expanded ? fullText : text)}
      {canExpand && (
        <Button size="compact" variant="ghost" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? '收起' : '展开全文'}
        </Button>
      )}
    </>
  )
}

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
