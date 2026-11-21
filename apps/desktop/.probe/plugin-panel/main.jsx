// 样式顺序与真实宿主 main.jsx 一致：共享入口的配置页 / Arco 样式 → app.css。
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArcoProvider, SplitView } from '@mica-config-ui/web'
import '../../src/renderer/assets/app.css'
import { ModalShell } from '../../src/renderer/src/chat-modal'
// 真实的面板渲染层：表格、字段、勾选列都走这一份，探针不另画一套。
import { PluginPanelSection } from '../../src/renderer/src/PluginPanels'
import view from './ssh-view.json'

const theme = new URLSearchParams(location.search).get('theme')
if (theme) {
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.setAttribute(
    'data-appearance',
    theme.includes('light') || theme === 'latte' ? 'light' : 'dark'
  )
}
document.body.classList.add('mica-arco-theme')

const sections = view.sections || []
const tabs = sections.map((section, index) => ({
  key: `${section.title}:${index}`,
  label: section.title,
  title: section.title
}))

/**
 * 探针「插件面板弹窗」。
 *
 * 这段外壳与 `PluginPanels.jsx` 的 `display === 'modal'` 分支同形（左栏分区 + 右栏详情），
 * 差别只有一处：页签状态留在这里，真实宿主里它跟着视图轮询走。看到版式问题先改宿主那份。
 */
function Probe() {
  const [active, setActive] = useState(0)
  const [drafts, setDrafts] = useState({})
  const section = sections[active]
  return (
    <ModalShell
      title={view.title}
      subtitle={view.subtitle}
      className="chat-plugin-modal"
      actions={<span className="chat-plugin-feedback" />}
      onClose={() => {}}
    >
      <div className="mica-config-ui is-embed chat-plugin-panel">
        <SplitView
          rail={
            <div className="split-rail-list" role="tablist" aria-label="面板分区">
              {tabs.map((tab, index) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={index === active}
                  className={`split-item${index === active ? ' is-active' : ''}`}
                  onClick={() => setActive(index)}
                >
                  <span className="split-item-copy">
                    <span className="split-item-title">{tab.label}</span>
                  </span>
                </button>
              ))}
            </div>
          }
        >
          <div className="chat-plugin-detail">
            <header className="chat-plugin-detail-head">
              <h2>{section?.title || view.title}</h2>
              {section?.subtitle ? <p>{section.subtitle}</p> : null}
            </header>
            <div className="chat-plugin-detail-body">
              {section && (
                <PluginPanelSection
                  section={section}
                  tabbed
                  draftScope={active}
                  drafts={drafts}
                  setDrafts={setDrafts}
                  commit={section.commit ? () => {} : null}
                  flushCommit={() => {}}
                  busy=""
                  runAction={(...args) => console.log('action', args)}
                />
              )}
            </div>
          </div>
        </SplitView>
      </div>
    </ModalShell>
  )
}

createRoot(document.getElementById('root')).render(
  <ArcoProvider>
    <Probe />
  </ArcoProvider>
)
