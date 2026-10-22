import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { IconX } from '@tabler/icons-react'

/**
 * 详情弹窗的唯一外壳（上下文占用、子代理、后台任务、工具调用、思考共用）。
 *
 * 之前每个弹窗各写一套 overlay/header/body，尺寸、内边距、关闭按钮和 Esc 行为都不一致，
 * 看起来像四个产品。这里收成一套：head 固定（标题 + 副标题 + 动作 + 关闭），meta 行固定，
 * body 是唯一滚动层。
 *
 * 走 portal 挂到 body：调用方可能在回合日志、BTW 抽屉这些自带 overflow 的容器里，
 * 留在原地会被裁掉或跟着容器滚动。
 */
export function ModalShell({
  title,
  icon = null,
  subtitle = null,
  meta = null,
  actions = null,
  onClose,
  bodyRef,
  onBodyScroll,
  className = '',
  children
}) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      onClose?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return createPortal(
    <div
      className="chat-modal-overlay no-drag"
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : undefined}
      onClick={(event) => event.target === event.currentTarget && onClose?.()}
    >
      <div
        className={`chat-modal ${className}`.trim()}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="chat-modal-header">
          {icon ? (
            <span className="chat-modal-mark" aria-hidden="true">
              {icon}
            </span>
          ) : null}
          <div className="chat-modal-heading">
            <span className="chat-modal-title">{title}</span>
            {subtitle ? <span className="chat-modal-subtitle">{subtitle}</span> : null}
          </div>
          <div className="chat-modal-actions">
            {actions}
            <button
              type="button"
              className="chat-modal-close"
              aria-label="关闭"
              title="关闭（Esc）"
              onClick={onClose}
            >
              <IconX size={14} />
            </button>
          </div>
        </header>
        {meta ? <div className="chat-modal-meta">{meta}</div> : null}
        <div ref={bodyRef} className="chat-modal-body" onScroll={onBodyScroll}>
          {children}
        </div>
      </div>
    </div>,
    document.body
  )
}

/** meta 行里的一项；分隔符由 `ModalMeta` 统一插，调用方不用自己拼「·」。 */
export function ModalMeta({ items }) {
  const visible = (items || []).filter((item) => item != null && item !== '')
  if (!visible.length) return null
  return (
    <>
      {visible.map((item, index) => (
        <span key={index} className="chat-modal-meta-item">
          {index > 0 ? (
            <span className="chat-modal-sep" aria-hidden="true">
              ·
            </span>
          ) : null}
          {item}
        </span>
      ))}
    </>
  )
}

/** 弹窗里的一段内容：小标题 + 右侧补充动作（复制、行数等）。 */
export function ModalSection({ title, extra = null, children }) {
  return (
    <section className="chat-modal-section">
      <div className="chat-modal-section-head">
        <span>{title}</span>
        {extra ? <span className="chat-modal-section-extra">{extra}</span> : null}
      </div>
      {children}
    </section>
  )
}
