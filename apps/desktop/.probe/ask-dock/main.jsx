// 探针「提问卡片」：`ask` 插件（`ctx.ask`）抛出的那张卡。
//
// 它是**高优先级**：这一轮正卡在这道题上，用户不答就没有下文。所以这里盯的不是
// 「好不好看」，而是「一屏里能不能最先看见它」。
//
// 卡片本身是正式组件（`ChatView.jsx` 的 `AskDock`），样式全部来自 `app.css`。
// 卡片下面那条假输入条只是用来给个上下文（真输入条是 `ChatComposer`，探针不引它，
// 它带 CWD / 模型 / 计时一堆宿主依赖），别把那条当产品。
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArcoProvider } from '@mica-config-ui/web'
import { AskDock } from '../../src/renderer/src/ChatView.jsx'
import '../../src/renderer/assets/app.css'
import './probe.css'

const THEMES = [
  { id: 'dark', label: 'Darcula' },
  { id: 'light', label: 'Light' },
  { id: 'mocha', label: 'Mocha' },
  { id: 'latte', label: 'Latte' },
  { id: 'tokyo-night', label: 'Tokyo' },
  { id: 'tokyo-night-light', label: 'Tokyo Light' }
]

function appearanceOf(theme) {
  return theme.includes('light') || theme === 'latte' ? 'light' : 'dark'
}

const CHOICE = {
  id: 'ask-choice',
  title: '先用哪个入口？',
  detail: '两个都能到同一页，区别只在进来之后先看到什么。',
  multiple: false,
  options: [
    { id: 'a', label: '方案 A：先做转账', description: '老用户最熟的路径，改动面最小' },
    { id: 'b', label: '方案 B：先做收款码', description: '新用户第一次打开就用到' },
    { id: 'c', label: '方案 C：两页一起改', description: '一次改完，但这次发布的验证量翻倍' }
  ]
}

const TEXT_ONLY = {
  id: 'ask-text',
  title: '这一步要改成什么？',
  options: [],
  display: { options: false, hint: false }
}

/** 多选：点两下才看得出「选中」与「确定可用」的样子。 */
const MULTI = { ...CHOICE, id: 'ask-multi', multiple: true }

const CONFIRM = {
  id: 'ask-confirm',
  title: '要我把这三个文件一起提交吗？',
  passive: true,
  options: [],
  // 老宿主还会下发 `input: false`：组件不读它，输入框照样在（这正是它该有的样子）
  display: { options: false, input: false, confirm: true, hint: true }
}

function FakeComposer() {
  return (
    <div className="probe-composer">
      <span>问点什么，或按 / 选命令…</span>
    </div>
  )
}

function Card({ label, ask, hint }) {
  return (
    <section className="probe-case">
      <div className="probe-case-label">
        {label}
        {hint ? <span className="probe-case-hint">{hint}</span> : null}
      </div>
      <div className="probe-dock">
        <AskDock ask={ask} submitting={false} onSubmit={() => {}} onCancel={() => {}} />
        <FakeComposer />
      </div>
    </section>
  )
}

function Probe() {
  const [theme, setTheme] = useState('dark')
  // 浮层版铺满整屏：默认关掉，否则它会把下面几种形态全遮住
  const [showModal, setShowModal] = useState(false)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.setAttribute('data-appearance', appearanceOf(theme))
  }, [theme])

  const modalAsk = { ...CHOICE, id: 'ask-modal', presentation: 'modal' }

  return (
    <>
      <div className="probe-toolbar">
        <span className="probe-toolbar-label">主题</span>
        {THEMES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`probe-theme${theme === item.id ? ' is-active' : ''}`}
            onClick={() => setTheme(item.id)}
          >
            {item.label}
          </button>
        ))}
        <span className="probe-toolbar-label probe-toolbar-gap">形态</span>
        <button
          type="button"
          className={`probe-theme${showModal ? ' is-active' : ''}`}
          onClick={() => setShowModal((value) => !value)}
        >
          浮层（modal）
        </button>
      </div>
      <div className="probe-stage">
        <Card
          label="多选题（3 个方案 + 自定义输入）"
          hint="点一个选项看选中态：单选点一下即提交，这里不做提交，只看样子"
          ask={CHOICE}
        />
        <Card
          label="多选（要选几个再点「确定」）"
          hint="选中的键位变实心青底、「确定」跟着可用"
          ask={MULTI}
        />
        <Card label="只写字，没有选项" ask={TEXT_ONLY} />
        <Card
          label="只确认（passive）"
          hint="宿主即便下发 `display.input: false`，自由输入框也不会消失"
          ask={CONFIRM}
        />
        {showModal ? (
          <AskDock ask={modalAsk} submitting={false} onSubmit={() => {}} onCancel={() => {}} />
        ) : null}
      </div>
    </>
  )
}

createRoot(document.getElementById('root')).render(
  <ArcoProvider>
    <Probe />
  </ArcoProvider>
)
