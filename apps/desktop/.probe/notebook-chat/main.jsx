import '@arco-design/web-react/es/_util/react-19-adapter'
// Match the real renderer: shared UI / Arco → app.css → notebook chunk.
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArcoProvider, Button, SelectMenu } from '@mica-config-ui/web'
import '../../src/renderer/assets/app.css'
import 'plugins/notebook/notebook.css'
import './probe.css'
import { createFakeSessions } from './fake-sessions.js'

const { NotebookChatDock } = await import('plugins/notebook/NotebookChatDock.jsx')
const FullNotebook = lazy(() => import('plugins/notebook/desktop.jsx'))
const PageMarkdown = lazy(() =>
  import('../../src/renderer/src/ChatView.jsx').then((module) => ({ default: module.Markdown }))
)
function HostMarkdown(props) {
  return (
    <Suspense fallback={<div className="chat-markdown whitespace-pre-wrap">{props.text}</div>}>
      <PageMarkdown {...props} />
    </Suspense>
  )
}

const params = new URLSearchParams(location.search)
const requestedRuntime = params.get('runtime')
const fullPage = Boolean(requestedRuntime) && params.get('page') === '1'
const runtimeTarget = __NOTEBOOK_PROBE_RUNTIME_TARGET__
const fake = createFakeSessions()
const realSent = []
let runtimeApi
let bootError = ''
if (requestedRuntime) {
  try {
    const target = new URL(requestedRuntime)
    if (!runtimeTarget || target.origin !== runtimeTarget || target.href !== `${target.origin}/`)
      throw new Error(
        'runtime 参数必须与启动 Vite 时显式设置的 MICA_PROBE_RUNTIME_TARGET 完全匹配；不允许默认运行时或 8787'
      )
    const [{ ensureMicaApi }, { createPluginHostApi }] = await Promise.all([
      import('../../src/renderer/src/transport.js'),
      import('../../src/renderer/src/plugin-host.js')
    ])
    await ensureMicaApi()
    const host = createPluginHostApi('notebook')
    if (!host.sessions) throw new Error('隔离运行时未提供 sessions API')
    runtimeApi = {
      ...host,
      page: {
        beforeClose: () => () => {},
        search: () => Object.fromEntries(new URLSearchParams(location.search)),
        setSearch: (values) => {
          const next = new URL(location.href)
          for (const [key, value] of Object.entries(values)) {
            if (value) next.searchParams.set(key, String(value))
            else next.searchParams.delete(key)
          }
          history.replaceState(null, '', next)
        }
      },
      sessions: {
        ...host.sessions,
        send: (input) => {
          realSent.push(structuredClone(input))
          return host.sessions.send(input)
        }
      }
    }
  } catch (error) {
    bootError = error.message || String(error)
  }
}

const scenarios = [
  ['immediate-text', '即时首帧'],
  ['manual', '手动流事件'],
  ['send-error', '发送失败'],
  ['queue-error', '异步队列拒绝'],
  ['abort-error', '停止失败'],
  ['history-error', '历史失败'],
  ['list-error', '列表失败'],
  ['long-history', '长历史'],
  ['empty', '空会话列表'],
  ['no-api', '缺少宿主能力']
].map(([value, label]) => ({ value, label }))

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
  document.documentElement.dataset.appearance = theme === 'light' ? 'light' : 'dark'
}
function measure(selector) {
  const node = document.querySelector(selector)
  if (!node) return null
  const rect = node.getBoundingClientRect()
  const style = getComputedStyle(node)
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    scrollTop: node.scrollTop,
    display: style.display,
    position: style.position,
    overflow: style.overflow,
    font: style.font,
    background: style.backgroundColor,
    color: style.color,
    border: style.border,
    padding: style.padding,
    disabled: node.disabled,
    text: node.innerText || node.value || ''
  }
}
function inspect() {
  const sample = {
    ready: !bootError,
    mode: requestedRuntime ? 'real' : 'fake',
    runtime: runtimeApi ? runtimeTarget : null,
    theme: document.documentElement.dataset.theme,
    viewport: { width: innerWidth, height: innerHeight },
    frame: measure('.notebook-chat-probe-frame'),
    page: measure('.notebook-page'),
    rail: measure('.notebook-rail'),
    editor: measure('.notebook-editor-area'),
    dock: measure('.notebook-chat'),
    log: measure('.notebook-chat-log'),
    composer: measure('.notebook-chat-compose textarea'),
    actions: measure('.notebook-chat-actions'),
    picker: measure('[aria-label="选择会话"][role="dialog"]') || measure('.notebook-chat-picker'),
    messages: [...document.querySelectorAll('.notebook-chat-message')].map((node) => ({
      role: node.classList.contains('is-user') ? 'user' : 'assistant',
      text: node.innerText
    })),
    buttons: [...document.querySelectorAll('.notebook-chat button')].map((node) => ({
      name: node.getAttribute('aria-label') || node.title || node.innerText,
      disabled: node.disabled
    })),
    fake: requestedRuntime ? null : fake.inspect(),
    sent: structuredClone(requestedRuntime ? realSent : fake.sent)
  }
  const output = document.getElementById('probe-out')
  if (output) output.textContent = JSON.stringify(sample, null, 2)
  return sample
}

function Probe() {
  const [theme, setTheme] = useState(params.get('theme') === 'darcula' ? 'darcula' : 'light')
  const [width, setWidth] = useState(
    ['1440', '1100', '760', '390'].includes(params.get('width')) ? params.get('width') : '1440'
  )
  const [scenario, setScenarioState] = useState('immediate-text')
  const [generation, setGeneration] = useState(0)
  const [open, setOpen] = useState(true)
  const [markdown, setMarkdown] = useState(params.get('markdown') !== 'off')
  const [customApi, setCustomApi] = useState(null)
  const api = useMemo(() => {
    const source = requestedRuntime
      ? runtimeApi
      : customApi || (scenario === 'no-api' ? {} : { sessions: fake.api })
    return { ...source, ...(markdown ? { ui: { Markdown: HostMarkdown } } : { ui: {} }) }
  }, [scenario, markdown, customApi])
  const selectScenario = (next) => {
    if (requestedRuntime)
      throw new Error('real 模式不注入 fake 场景；请在无 runtime 参数的页面测试')
    fake.setScenario(next)
    setCustomApi(null)
    setScenarioState(next)
    setGeneration((value) => value + 1)
    setOpen(true)
  }
  useEffect(() => {
    applyTheme(theme)
  }, [theme])
  useEffect(() => {
    window.__probe = {
      ready: !bootError,
      mode: requestedRuntime ? 'real' : 'fake',
      sent: requestedRuntime ? realSent : fake.sent,
      inspect,
      setTheme: (next) => setTheme(next === 'darcula' ? 'darcula' : 'light'),
      setWidth: (next) => setWidth(String(next)),
      setOpen,
      setMarkdown,
      ...(requestedRuntime
        ? {}
        : {
            fake,
            setScenario: selectScenario,
            setApi: (next) => {
              setCustomApi(next)
              setGeneration((value) => value + 1)
            },
            configure: fake.configure,
            release: fake.release,
            reject: fake.reject,
            text: fake.text,
            event: fake.event,
            finish: fake.finish,
            queueError: fake.queueError
          })
    }
    return () => {
      delete window.__probe
    }
  }, [])

  return (
    <ArcoProvider>
      <div className="notebook-chat-probe-shell">
        <header className="notebook-chat-probe-toolbar" aria-label="探针辅助工具">
          <strong>Notebook · 对话探针</strong>
          <span>
            {requestedRuntime
              ? `真实隔离运行时 ${runtimeTarget || '未配置'}`
              : '内存假会话 · 不联网'}
          </span>
          <SelectMenu
            ariaLabel="探针宽度"
            size="compact"
            value={width}
            options={['1440', '1100', '760', '390'].map((value) => ({
              value,
              label: `${value}px 容器`
            }))}
            onChange={setWidth}
          />
          <SelectMenu
            ariaLabel="探针主题"
            size="compact"
            value={theme}
            options={[
              { value: 'light', label: '浅色' },
              { value: 'darcula', label: 'Darcula' }
            ]}
            onChange={setTheme}
          />
          {!requestedRuntime && (
            <SelectMenu
              ariaLabel="假 API 场景"
              size="compact"
              value={scenario}
              options={scenarios}
              onChange={selectScenario}
            />
          )}
          <Button variant="ghost" size="compact" onClick={() => setMarkdown((value) => !value)}>
            Markdown {markdown ? '开' : '关'}
          </Button>
          <Button variant="ghost" size="compact" onClick={() => setOpen((value) => !value)}>
            {open ? '收起' : '打开'}对话
          </Button>
          <Button variant="ghost" size="compact" onClick={inspect}>
            输出测量
          </Button>
        </header>
        {bootError ? (
          <p role="alert" className="notebook-chat-probe-error">
            {bootError}（未挂载对话，不回退 fake / 默认运行时）
          </p>
        ) : (
          <div className="notebook-chat-probe-stage">
            <div className="notebook-chat-probe-frame" style={{ width: `${width}px` }}>
              {fullPage ? (
                <Suspense fallback={<span>正在加载笔记页…</span>}>
                  <FullNotebook api={api} />
                </Suspense>
              ) : (
                <div className="notebook-page is-rail-open">
                  <div className="notebook-layout">
                    <aside className="notebook-rail" aria-label="笔记目录占位">
                      <div className="notebook-rail-title">
                        <strong>我的笔记</strong>
                      </div>
                      <div className="notebook-chat-probe-notes">
                        <p>▾ 项目笔记</p>
                        <p>　布局与交互验证</p>
                        <p>　发布检查清单</p>
                        <p>▾ 日常记录</p>
                      </div>
                    </aside>
                    <main className="notebook-main">
                      <div className="notebook-document-body">
                        <section
                          className="notebook-editor-area has-note"
                          aria-label="编辑器占位（非测试目标）"
                        >
                          <article className="notebook-chat-probe-document">
                            <small>我的笔记 / 项目笔记</small>
                            <h1>布局与交互验证</h1>
                            <p>中间区域只是静态占位，右侧才是真实的 NotebookChatDock 组件。</p>
                            <h2>检查清单</h2>
                            <p>
                              在不同宽度与主题下，检查会话选择、草稿、流式回复、停止和错误恢复。
                            </p>
                            <p>
                              此处的文字不会作为上下文发给模型。发送记录可从 window.__probe.sent
                              读取。
                            </p>
                          </article>
                        </section>
                        <NotebookChatDock
                          key={generation}
                          api={api}
                          open={open}
                          onClose={() => setOpen(false)}
                        />
                      </div>
                    </main>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        <pre id="probe-out" hidden aria-hidden="true" />
      </div>
    </ArcoProvider>
  )
}

createRoot(document.getElementById('root')).render(<Probe />)
