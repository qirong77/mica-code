import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, PluginIcon } from '@mica-config-ui/web'
import { Markdown } from './ChatView'
import './quick-buttons-preview-demo.css'

const DEMO_ITEMS = [
  {
    id: 'markdown', label: '生成报告', icon: 'file-text', color: 'accent',
    preview: {
      title: 'Markdown 报告已生成', subtitle: '刚刚 · 12 KB',
      markdown: '# 本次变更\n\n- 完成快捷按钮预览\n- 通过 18 项测试\n\n```text\n报告.md\n```',
      note: '预览卡片里的动作只显示反馈，不会修改文件。',
      actions: [{ id: 'open', label: '在 Mica 中打开', tone: 'primary' }, { id: 'ask', label: '继续追问' }]
    }
  },
  {
    id: 'spreadsheet', label: 'Excel / CSV', icon: 'database', color: 'success', shape: 'soft',
    preview: {
      title: '数据产物已就绪', subtitle: '2 个文件 · 456 行',
      text: 'sales.xlsx\nsales.csv\n\n可在对应应用中继续查看，也可以先在 Mica 里确认内容。',
      actions: [{ id: 'preview', label: '打开预览', tone: 'primary' }, { id: 'verify', label: '运行验证' }]
    }
  },
  {
    id: 'service', label: '服务已启动', icon: 'server', color: 'success',
    preview: {
      title: '本地服务正在运行', subtitle: 'http://127.0.0.1:3000',
      text: '健康检查通过。点击“打开预览”查看页面，或继续追问下一步。',
      actions: [{ id: 'open', label: '打开预览', tone: 'primary' }, { id: 'ask', label: '继续追问' }]
    }
  },
  {
    id: 'tests', label: '测试通过', icon: 'shield-check', color: 'success', shape: 'plain',
    preview: {
      title: '验证结果', subtitle: '18 passed · 0 failed · 1.4s',
      markdown: '`bun test plugin-panels.test.js`\n\n所有相关测试已通过。',
      actions: [{ id: 'verify', label: '运行验证', tone: 'primary' }]
    }
  },
  {
    id: 'question', label: '继续追问', icon: 'message-square', color: 'warn', iconOnly: true,
    preview: {
      title: '继续追问', subtitle: '把当前结果带回输入框',
      text: '动作不会替代快捷按钮本身的行为，只会把反馈交给宿主。',
      actions: [{ id: 'ask', label: '继续追问', tone: 'primary' }]
    }
  },
  {
    id: 'choice', label: '候选摘要', icon: 'list-checks', color: 'danger',
    preview: {
      title: '两个候选方案', subtitle: '先看一眼，再决定是否继续',
      text: '候选 A：沿用当前方案\n候选 B：先生成一份对比报告',
      note: '主动作只显示反馈，不会真的提交选择。',
      actions: [{ id: 'choose-a', label: '选择候选 A', tone: 'primary' }, { id: 'choose-b', label: '选择候选 B' }]
    }
  }
]

function DemoPreview({ item, anchor, onClose, onAction }) {
  const ref = useRef(null)
  const [position, setPosition] = useState(anchor)
  useEffect(() => {
    const close = (event) => {
      if (event.target?.closest?.('.quick-buttons-demo-button, .quick-buttons-demo-preview')) return
      onClose()
    }
    const escape = (event) => event.key === 'Escape' && onClose()
    const viewport = () => onClose()
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', escape)
    window.addEventListener('scroll', viewport, true)
    window.addEventListener('resize', viewport)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', escape)
      window.removeEventListener('scroll', viewport, true)
      window.removeEventListener('resize', viewport)
    }
  }, [onClose])
  useEffect(() => {
    if (!ref.current) return
    const { width, height } = ref.current.getBoundingClientRect()
    let left = Math.min(anchor.left, window.innerWidth - width - 12)
    let top = anchor.top - height - 8
    if (top < 12) top = anchor.bottom + 8
    setPosition({ left: Math.max(12, left), top: Math.max(12, Math.min(top, window.innerHeight - height - 12)) })
  }, [anchor, item])
  return createPortal(
    <div
      ref={ref}
      className="quick-buttons-demo-preview"
      role="dialog"
      aria-label={item.preview.title}
      style={{ left: position.left, top: position.top }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="quick-buttons-demo-preview-head">
        <strong>{item.preview.title}</strong>
        <span>{item.preview.subtitle}</span>
      </div>
      <div className="quick-buttons-demo-preview-body">
        {item.preview.markdown ? <Markdown text={item.preview.markdown} /> : <p>{item.preview.text}</p>}
      </div>
      {item.preview.note && <p className="quick-buttons-demo-preview-note">{item.preview.note}</p>}
      <div className="quick-buttons-demo-preview-actions">
        {item.preview.actions.map((action) => (
          <Button
            key={action.id}
            size="compact"
            variant={action.tone === 'primary' ? 'accent' : 'default'}
            onClick={() => {
              onClose()
              onAction(action.label)
            }}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </div>,
    document.body
  )
}

export default function QuickButtonsPreviewDemo() {
  const [open, setOpen] = useState(null)
  const [feedback, setFeedback] = useState('')
  const hoverTimer = useRef(0)

  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  const show = (event, item) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setOpen({ item, anchor: { left: rect.left, top: rect.top, bottom: rect.bottom } })
  }
  const delayedShow = (event, item) => {
    clearTimeout(hoverTimer.current)
    const rect = event.currentTarget.getBoundingClientRect()
    hoverTimer.current = window.setTimeout(() => {
      setOpen({ item, anchor: { left: rect.left, top: rect.top, bottom: rect.bottom } })
    }, 180)
  }
  const act = (label) => setFeedback(`${label} · 仅演示反馈，不修改文件`)

  return (
    <main className="quick-buttons-demo-page">
      <header className="quick-buttons-demo-header">
        <span className="quick-buttons-demo-eyebrow">交互演示 · 不修改文件</span>
        <h1>快捷按钮预览</h1>
        <p>悬停约 180ms、点击或用键盘聚焦按钮，查看统一的产物与验证卡片。</p>
      </header>
      <section className="quick-buttons-demo-stage" aria-label="快捷按钮演示">
        <div className="quick-buttons-demo-composer">
          <div className="quick-buttons-demo-input">描述你想继续处理的事情…</div>
          <div className="quick-buttons-demo-bar" role="toolbar" aria-label="模拟快捷条">
            {DEMO_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`quick-buttons-demo-button color-${item.color || 'default'}${item.shape ? ` shape-${item.shape}` : ''}${item.iconOnly ? ' is-icon-only' : ''}`}
                aria-label={item.iconOnly ? item.label : undefined}
                title={item.label}
                onMouseEnter={(event) => delayedShow(event, item)}
                onMouseLeave={() => clearTimeout(hoverTimer.current)}
                onFocus={(event) => show(event, item)}
                onClick={() => {
                  clearTimeout(hoverTimer.current)
                  setOpen(null)
                  act(`${item.label}已执行`)
                }}
              >
                <PluginIcon name={item.icon} size={13} />
                {!item.iconOnly && item.label}
              </button>
            ))}
          </div>
          {feedback && <p className="quick-buttons-demo-feedback" role="status">{feedback}</p>}
        </div>
        <p className="quick-buttons-demo-hint">点击快捷按钮仍执行按钮动作；卡片内的动作才会继续展示对应反馈。必须阻塞用户决策时，插件仍可使用原有 dialog 弹窗。</p>
      </section>
      {open && (
        <DemoPreview
          item={open.item}
          anchor={open.anchor}
          onClose={() => setOpen(null)}
          onAction={act}
        />
      )}
    </main>
  )
}
