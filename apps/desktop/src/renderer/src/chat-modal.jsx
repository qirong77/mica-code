import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { IconX } from '@tabler/icons-react'

/**
 * 当前打开的弹窗（后打开的在栈顶）。
 *
 * Esc 只关栈顶那一层：套一层的详情弹窗（会话设置 → 能力详情）以前各自监听 window，
 * 一次 Esc 会把两层一起关掉。BTW 抽屉的 capture 监听也据此判断是否让位。
 */
const modalStack = []

/** 有弹窗打开时，外层容器（BTW 抽屉）的 Esc 要让位给栈顶弹窗。 */
export function isModalOpen() {
  return modalStack.length > 0
}

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
  /** 表单类弹窗的底部动作区；详情弹窗不放 footer 时 body 直接贴底。 */
  footer = null,
  onClose,
  bodyRef,
  onBodyScroll,
  /** 套在另一个弹窗里时置 true：不叠第二层遮罩，只压暗一点点区分层级。 */
  nested = false,
  className = '',
  children
}) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const entry = { close: () => closeRef.current?.() }
    modalStack.push(entry)
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      if (modalStack[modalStack.length - 1] !== entry) return
      event.stopPropagation()
      entry.close()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      const index = modalStack.indexOf(entry)
      if (index >= 0) modalStack.splice(index, 1)
    }
  }, [])

  return createPortal(
    <div
      className={`chat-modal-overlay no-drag${nested ? ' is-nested' : ''}`}
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
          {/* 没有图标也占住标记位：标题的左边缘在所有弹窗里保持一致 */}
          <span className={`chat-modal-mark${icon ? '' : ' is-empty'}`} aria-hidden="true">
            {icon}
          </span>
          <div className="chat-modal-heading">
            <span className="chat-modal-title">{title}</span>
            {subtitle ? (
              <span
                className="chat-modal-subtitle"
                title={typeof subtitle === 'string' ? subtitle : undefined}
              >
                {subtitle}
              </span>
            ) : null}
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
        {footer ? <footer className="chat-modal-footer">{footer}</footer> : null}
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
