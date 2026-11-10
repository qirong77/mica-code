import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../../packages/mica-config-ui/web/styles.css'
import '../../src/renderer/assets/app.css'
import { ArcoProvider, Input } from '../../../../packages/mica-config-ui/web/components/ArcoSettings'
import { Button, SettingsGroup, SettingRow, Switch, Tag } from '../../../../packages/mica-config-ui/web/components/Ui'
import { PageFrame } from '../../../../packages/mica-config-ui/web/components/PageFrame'
import { SelectMenu } from '../../../../packages/mica-config-ui/web/components/SelectMenu'
import { Modal } from '../../../../packages/mica-config-ui/web/components/Modal'
import { DialogHost, confirmDialog, promptDialog } from '../../../../packages/mica-config-ui/web/components/DialogHost'
import { ConfigPage } from '../../../../packages/mica-config-ui/web/pages/ConfigPage'
import { setConfigWebClient } from '../../../../packages/mica-config-ui/web/api'
import { THEME_OPTIONS } from '../../../../packages/mica-config-ui/web/theme'
import { applyResolvedTheme } from '../../src/renderer/src/theme.js'
import './preview.css'

// This client deliberately has no HTTP/IPC implementation. Even “测试连接” is a mock.
let configContent = JSON.stringify({
  providers: [
    {
      id: 'Example Cloud',
      api_base: 'https://cloud.example.invalid/v1',
      api_key: 'demo-key-not-a-secret',
      protocol: 'openai_responses',
      models: ['example-reasoner', 'example-mini']
    },
    {
      id: 'Local Preview',
      api_base: 'https://local.example.invalid/v1',
      protocol: 'openai_chat_completions',
      models: ['example-chat']
    }
  ],
  defaultModel: { provider: 'Example Cloud', model: 'example-reasoner' }
}, null, 2)
const memoryPath = '/example/preview/config.json'
setConfigWebClient({
  readConfigFile: async () => ({ path: memoryPath, content: configContent }),
  writeConfigFile: async (content) => {
    configContent = content
    return { path: memoryPath, content }
  },
  testProvider: async ({ model }) => ({
    ok: true,
    message: '模拟成功：未请求任何服务商，仅验证共享结果提示。',
    latencyMs: 0,
    model,
    reply: '这是一条内存中的示例回复。'
  })
})

const pages = [
  { value: 'config', label: '真实配置页' },
  { value: 'controls', label: '控件与弹窗' }
]
const themes = THEME_OPTIONS.filter((option) => option.value !== 'auto')
const params = new URLSearchParams(window.location.search)
const initialTheme = themes.some((option) => option.value === params.get('theme')) ? params.get('theme') : 'light'
const initialPage = pages.some((option) => option.value === params.get('page')) ? params.get('page') : 'config'
applyResolvedTheme(initialTheme)

function ControlsPage() {
  const [name, setName] = useState('日常工作区')
  const [endpoint, setEndpoint] = useState('不是有效的地址')
  const [model, setModel] = useState('balanced')
  const [enabled, setEnabled] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalName, setModalName] = useState('浅色方案')
  const [result, setResult] = useState('尚未操作。结果只显示在此处，不会写入磁盘。')
  const endpointError = /^https?:\/\/\S+$/.test(endpoint) ? undefined : '请输入以 http:// 或 https:// 开头的地址。'
  const modelOptions = [
    { value: 'balanced', label: '均衡 · Balanced' },
    { value: 'fast', label: '快速 · Fast' },
    { value: 'deep', label: '深入 · Deep' },
    { value: 'unavailable', label: '暂不可用', disabled: true }
  ]

  async function showConfirm(danger = false) {
    const accepted = await confirmDialog({
      title: danger ? '删除示例工作区？' : '应用这份示例设置？',
      message: danger
        ? '这是危险操作的视觉与键盘交互演示。不会删除任何文件或真实工作区。'
        : '使用真正的 confirmDialog 与 DialogHost。按 Tab / Shift+Tab 检查焦点，按 Esc 取消。',
      confirmText: danger ? '删除示例' : '应用设置',
      danger
    })
    setResult(`${danger ? '危险确认' : '普通确认'}：${accepted ? '已确认（仅演示）' : '已取消'}。`)
  }

  async function showPrompt() {
    const value = await promptDialog({
      title: '重命名示例工作区',
      message: '清空后确定按钮禁用；输入名称后可按 Enter 提交，Esc 取消。',
      label: '工作区名称',
      placeholder: '请输入名称',
      initialValue: name,
      confirmText: '保存名称'
    })
    if (value !== null) setName(value)
    setResult(value === null ? '输入弹窗：已取消。' : `输入弹窗：已保存“${value}”（仅内存）。`)
  }

  return (
    <PageFrame title="控件与弹窗" description="真实共享控件：文字层级、表单状态、紧凑工具栏与主次动作" actions={<Tag>交互可用 · 仅内存</Tag>}>
      <div className="arco-preview-groups">
        <SettingsGroup title="输入与说明" description="说明文字不是禁用态；错误、占位与禁用分别展示。">
          <SettingRow label="工作区名称" htmlFor="preview-name" hint="可以直接编辑。此处为正常字段说明，用于观察小字号的可读性。">
            <Input id="preview-name" value={name} onChange={setName} placeholder="例如：日常工作区" />
          </SettingRow>
          <SettingRow label="可选备注" htmlFor="preview-note" hint="输入为空时显示占位提示。">
            <Input id="preview-note" placeholder="添加一句说明（可选）" allowClear />
          </SettingRow>
          <SettingRow label="服务地址" htmlFor="preview-endpoint" error={endpointError}>
            <Input id="preview-endpoint" value={endpoint} onChange={setEndpoint} status={endpointError ? 'error' : undefined} aria-invalid={!!endpointError} />
          </SettingRow>
          <SettingRow label="只读示例" htmlFor="preview-disabled" hint="禁用控件与正常说明应有明确区别。">
            <Input id="preview-disabled" value="由宿主管理，当前不可编辑" disabled />
          </SettingRow>
        </SettingsGroup>

        <SettingsGroup title="选择与密度" description="表单默认尺寸与 compact 工具栏尺寸来自同一份适配层。">
          <SettingRow label="默认模式" htmlFor="preview-model" hint="支持键盘选择、过滤与禁用选项。">
            <SelectMenu id="preview-model" ariaLabel="默认模式" value={model} options={modelOptions} onChange={setModel} filterable />
          </SettingRow>
          <SettingRow label="紧凑工具栏">
            <div className="arco-preview-inline">
              <div className="arco-preview-compact-select"><SelectMenu ariaLabel="紧凑模式" value={model} options={modelOptions} onChange={setModel} size="compact" /></div>
              <Button size="compact" onClick={() => setResult('紧凑工具栏：已刷新示例。')}>刷新</Button>
              <Button size="compact" variant="accent" onClick={() => setResult('紧凑工具栏：已开始示例。')}>开始</Button>
            </div>
          </SettingRow>
          <SettingRow label="自动整理" hint="开关可以切换，不影响当前应用。">
            <Switch checked={enabled} label="自动整理" onChange={setEnabled} />
          </SettingRow>
          <SettingRow label="禁用开关"><Switch checked={false} label="禁用开关示例" disabled onChange={() => {}} /></SettingRow>
        </SettingsGroup>

        <SettingsGroup title="动作与弹窗" description="保留中性次动作，让真正的主操作更清楚；弹层没有单独绘制预览皮肤。">
          <SettingRow label="按钮层级">
            <div className="arco-preview-inline">
              <Button variant="accent" onClick={() => setResult('主操作：已保存示例（仅内存）。')}>保存设置</Button>
              <Button onClick={() => setResult('次操作：已取消示例。')}>取消</Button>
              <Button variant="ghost" onClick={() => setResult('文字动作：已查看示例说明。')}>查看说明</Button>
              <Button variant="accent" disabled onClick={() => {}}>暂不可用</Button>
            </div>
          </SettingRow>
          <SettingRow label="真实弹窗">
            <div className="arco-preview-inline">
              <Button onClick={() => setModalOpen(true)}>表单 Modal</Button>
              <Button onClick={() => void showConfirm()}>普通确认</Button>
              <Button onClick={() => void showPrompt()}>输入弹窗</Button>
              <Button variant="danger-ghost" onClick={() => void showConfirm(true)}>危险确认</Button>
            </div>
          </SettingRow>
          <SettingRow label="操作结果"><p className="arco-preview-result" role="status" aria-live="polite">{result}</p></SettingRow>
        </SettingsGroup>
      </div>

      {modalOpen ? (
        <Modal title="编辑示例方案" onClose={() => setModalOpen(false)}>
          <div className="dialog-form">
            <p className="dialog-message">这是共享 Modal 的表单用法。试试输入、Tab 循环、Esc 关闭与关闭后的焦点回到触发按钮。</p>
            <label className="dialog-field" htmlFor="preview-modal-name">
              <span>方案名称</span>
              <Input id="preview-modal-name" autoFocus value={modalName} onChange={setModalName} placeholder="输入方案名称" />
            </label>
            <div className="dialog-actions">
              <Button onClick={() => setModalOpen(false)}>取消</Button>
              <Button variant="accent" disabled={!modalName.trim()} onClick={() => {
                setResult(`表单弹窗：已保存“${modalName}”（仅内存）。`)
                setModalOpen(false)
              }}>保存方案</Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </PageFrame>
  )
}

function App() {
  const [page, setPage] = useState(initialPage)
  const [theme, setTheme] = useState(initialTheme)

  useEffect(() => {
    // applyResolvedTheme only sets DOM attributes; no user preference/cache is read or written.
    applyResolvedTheme(theme)
    const url = new URL(window.location.href)
    url.searchParams.set('page', page)
    url.searchParams.set('theme', theme)
    window.history.replaceState(null, '', url)
  }, [page, theme])

  return (
    <ArcoProvider>
      <div className="mica-config-ui arco-light-preview">
        <header className="arco-preview-toolbar">
          <div className="arco-preview-heading">
            <strong>Mica · 浅色 Arco 预览</strong>
            <p>真实共享组件 · 示例数据仅内存 · 不读取用户配置、不请求 API</p>
          </div>
          <div className="arco-preview-toolbar-controls">
            <div className="arco-preview-picker">
              <span id="preview-page-label">示例页面</span>
              <SelectMenu ariaLabel="示例页面" value={page} options={pages} onChange={setPage} />
            </div>
            <div className="arco-preview-picker">
              <span id="preview-theme-label">主题</span>
              <SelectMenu ariaLabel="主题" value={theme} options={themes} onChange={setTheme} />
            </div>
          </div>
        </header>
        <div className="arco-preview-stage">
          {page === 'config' ? <ConfigPage /> : <ControlsPage />}
        </div>
        <DialogHost />
      </div>
    </ArcoProvider>
  )
}

createRoot(document.getElementById('root')).render(<App />)
