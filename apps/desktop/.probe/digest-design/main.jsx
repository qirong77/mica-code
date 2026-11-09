import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import Card from '@arco-design/web-react/es/Card'
import Alert from '@arco-design/web-react/es/Alert'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArcoProvider,
  Button,
  Segmented,
  SelectMenu,
  Tag,
  THEME_OPTIONS
} from '@mica-config-ui/web'
import { applyThemePreference } from '../../src/renderer/src/theme.js'
import { DigestNotice } from '../../src/renderer/src/DigestNotice.jsx'
import '../../src/renderer/assets/app.css'
import './probe.css'

const DESIGNS = [
  {
    value: 'a',
    label: 'A · 标准卡片',
    component: 'Arco Card · small',
    description: '保留清晰的标题和分隔线，去掉装饰与内框。正文始终可见，不改变阅读方式。'
  },
  {
    value: 'b',
    label: 'B · 轻量提示',
    component: 'Arco Alert · info',
    description: '用中性浅底承接摘要，标题与正文紧凑相连。不是警告，也不使用大面积蓝色。'
  },
  {
    value: 'c',
    label: 'C · 可收起摘要（已选）',
    component: 'Arco Collapse · 默认展开',
    description: '已接入正式组件：默认显示完整摘要；点击标题或聚焦后按 Enter 可收起 / 展开，原回复不受影响。'
  }
]

const SUMMARY = [
  '- **结论**：示例项目的消息流可以保持不变，只替换摘要容器；摘要仍出现在原回复之后。',
  '- **实现**：摘要正文继续使用 Markdown，保留 **重点文字** 与 `renderSummary()` 等行内代码。',
  '- **定位**：虚构文件路径为 `/example/workspace/sample-app/packages/conversation/components/summary/variants/neutral-card/LongReplySummaryNotice.tsx`，窄窗口也应自然换行。',
  '- **下一步**：方案 C 已复用正式摘要组件；本页仍使用示例内容，**不读写应用或会话数据**。'
].join('\n')

const REPLY_EXCERPT = [
  '已检查示例项目的消息展示流程。建议保留对话列与原回复，只调整摘要的容器，让阅读层级更清楚。',
  '',
  '原回复会继续展示实现过程、边界条件与验证步骤。下方是它结束后自动整理的四条要点。'
].join('\n')

function readInitialState() {
  const params = new URLSearchParams(window.location.search)
  return {
    variant: DESIGNS.some((design) => design.value === params.get('variant'))
      ? params.get('variant')
      : 'c',
    theme: THEME_OPTIONS.some((option) => option.value === params.get('theme'))
      ? params.get('theme')
      : 'auto',
    compare: params.get('compare') === '1'
  }
}

function syncUrl({ variant, theme, compare }) {
  try {
    const url = new URL(window.location.href)
    url.searchParams.set('variant', variant)
    url.searchParams.set('theme', theme)
    if (compare) url.searchParams.set('compare', '1')
    else url.searchParams.delete('compare')
    window.history.replaceState(null, '', url)
  } catch {
    // file:// and restrictive hosts may reject replaceState; the preview still works.
  }
}

const initialState = readInitialState()
applyThemePreference(initialState.theme, { cache: false })

function Markdown({ text, className = 'digest-design-markdown' }) {
  return (
    <div className={`chat-markdown ${className}`.trim()}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  )
}

function Metadata() {
  return <span className="digest-design-meta">自动整理</span>
}

function DigestCandidate({ variant }) {
  const content = <Markdown text={SUMMARY} />

  if (variant === 'b') {
    return (
      <Alert
        className="digest-design-candidate digest-design-alert"
        type="info"
        showIcon={false}
        title={
          <span className="digest-design-alert-heading">
            <span>长回复摘要</span>
            <Metadata />
          </span>
        }
        content={content}
      />
    )
  }

  if (variant === 'c') {
    return (
      <DigestNotice>
        <Markdown text={SUMMARY} className="" />
      </DigestNotice>
    )
  }

  return (
    <Card
      className="digest-design-candidate digest-design-card"
      size="small"
      title="长回复摘要"
      extra={<Metadata />}
    >
      {content}
    </Card>
  )
}

function ChatRow({ role, children }) {
  return (
    <div className={`chat-message chat-message-${role}`}>
      <div className="chat-message-marker" aria-hidden="true">
        {role === 'user' ? '▌' : '●'}
      </div>
      <div className="chat-message-body">{children}</div>
    </div>
  )
}

function Conversation({ design, compare }) {
  return (
    <section
      className="digest-design-conversation chat-view"
      data-design={design.value}
      aria-label={`${design.label}：消息流中的摘要`}
    >
      {compare ? (
        <header className="digest-design-column-heading">
          <strong>{design.label}</strong>
          <Tag>{design.value === 'c' ? '已选 C · 正式组件' : '备选外观'}</Tag>
        </header>
      ) : null}
      <div className="chat-transcript digest-design-transcript">
        <ChatRow role="user">这段实现的结论是什么？</ChatRow>
        <ChatRow role="assistant">
          <p className="digest-design-excerpt-label">原回复节选 · 示例内容</p>
          <Markdown text={REPLY_EXCERPT} />
          <p className="digest-design-omitted">其余实现细节与验证过程在此省略。</p>
        </ChatRow>
        <section className="digest-design-notice" aria-label="长回复摘要">
          <DigestCandidate variant={design.value} />
        </section>
        <div className="digest-design-followup">
          <ChatRow role="user">明白了，先保留这个方向。</ChatRow>
        </div>
      </div>
      {compare ? <p className="digest-design-column-note">{design.description}</p> : null}
    </section>
  )
}

function App() {
  const [variant, setVariant] = useState(initialState.variant)
  const [theme, setTheme] = useState(initialState.theme)
  const [compare, setCompare] = useState(initialState.compare)
  const selected = DESIGNS.find((design) => design.value === variant)

  useEffect(() => {
    applyThemePreference(theme, { cache: false })
    syncUrl({ variant, theme, compare })
  }, [variant, theme, compare])

  return (
    <ArcoProvider>
      <div className="digest-design-probe">
        <header className="digest-design-toolbar">
          <div className="digest-design-heading">
            <div>
              <p className="digest-design-disclaimer">外观方案 · 示例内容，不修改当前应用</p>
              <h1>长回复摘要</h1>
            </div>
            <Tag>已选 C · 可收起摘要</Tag>
          </div>
          <div className="digest-design-controls">
            <div className="digest-design-control">
              <span className="digest-design-control-label">外观方案</span>
              <Segmented
                ariaLabel="选择摘要外观方案"
                value={variant}
                options={DESIGNS.map(({ value, label }) => ({ value, label }))}
                onChange={(next) => {
                  setVariant(next)
                  setCompare(false)
                }}
              />
            </div>
            <div className="digest-design-control digest-design-theme-control">
              <label className="digest-design-control-label" htmlFor="digest-design-theme">主题</label>
              <SelectMenu
                id="digest-design-theme"
                ariaLabel="预览主题"
                value={theme}
                options={THEME_OPTIONS}
                menuMinWidth={210}
                onChange={setTheme}
              />
            </div>
            <div className="digest-design-compare-control">
              <Button
                variant="ghost"
                pressed={compare}
                onClick={() => setCompare((value) => !value)}
              >
                {compare ? '返回单版' : '三版并排'}
              </Button>
            </div>
          </div>
        </header>
        <main className="digest-design-main" data-design={variant}>
          <div className="digest-design-context" aria-live="polite">
            <div className="digest-design-context-title">
              <strong>{compare ? '三版对照 · 同一份消息与摘要' : selected.label}</strong>
              <span>{compare ? 'Card / Alert / Collapse' : selected.component}</span>
            </div>
            <p>
              {compare
                ? 'A / B 保持摘要常显；C 默认展开，可点击标题收起。所有方案都不折叠原回复。'
                : selected.description}
            </p>
          </div>
          <div className={`digest-design-previews${compare ? ' is-compare' : ''}`}>
            {(compare ? DESIGNS : [selected]).map((design) => (
              <Conversation key={design.value} design={design} compare={compare} />
            ))}
          </div>
        </main>
      </div>
    </ArcoProvider>
  )
}

createRoot(document.getElementById('root')).render(<App />)
