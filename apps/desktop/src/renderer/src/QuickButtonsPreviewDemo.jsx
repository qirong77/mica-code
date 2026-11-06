import { useCallback, useEffect, useRef, useState } from 'react'
import { PageFrame, PluginIcon, SettingRow, SettingsGroup, Tag } from '@mica-config-ui/web'
import { quickbarButtonLook } from './plugin-panels'
import { PREVIEW_HOVER_DELAY_MS, QuickbarPreview } from './PluginPanels'
import './quick-buttons-preview-demo.css'

/**
 * 快捷按钮与预览卡片的外观验收页（`?quick-buttons-demo=1`）。
 *
 * 这一页不只是演示按钮本身，也要演示它们落在什么版式里：整页骨架用组件库的
 * `PageFrame`（页头 / 说明 / 可滚内容区），场景用 `SettingsGroup` + `SettingRow`
 * 分块，状态用 `Tag`。按钮走生产的 `quickbarButtonLook`（同一套
 * `chat-plugin-quickbar-*` 类），卡片直接用生产的 `QuickbarPreview`。
 *
 * 所以这里**没有自己的一套视觉**：不另写页头、不另写卡片、不另写按钮。一旦演示页
 * 自己画，它验证的东西就和对话里出现的不是同一件了。
 */
const SCENARIOS = [
  {
    id: 'artifact',
    name: '生成了文件',
    kind: '文件产物',
    tone: 'blue',
    note: '模型写完 Markdown / 代码产物后，把路径挂在一颗按钮上；悬停看摘要，点卡片里的动作才真的打开。',
    message: '已生成变更说明，写到 `docs/review.md`。',
    buttons: [
      {
        label: 'review.md',
        action: 'openArtifact',
        style: { icon: 'file-text', color: 'accent' },
        preview: {
          title: 'review.md 已生成',
          subtitle: 'docs/review.md · 2.1 KB · 18 行',
          markdown:
            '# 本次变更\n\n- 快捷按钮支持预览卡片\n- 预览里的动作仍交给插件执行\n\n```bash\nbun run typecheck\n```',
          note: '打开后进入编辑器；不打开也能先确认内容对不对。',
          actions: [
            { action: 'openInApp', label: '在 Mica 中打开', tone: 'primary' },
            { action: 'compose', label: '继续追问' }
          ]
        }
      },
      {
        label: '继续追问',
        action: 'ask',
        style: { icon: 'message-square', shape: 'plain' }
      }
    ]
  },
  {
    id: 'table',
    name: '生成了表格',
    kind: '表格产物',
    tone: 'blue',
    note: 'Excel / CSV 这类产物在卡片里先看前几行与合计，确认列和数对得上再打开。',
    message: '数据已导出到 `sales.xlsx` 与 `sales.csv`。',
    buttons: [
      {
        label: 'Excel / CSV',
        action: 'openSheet',
        style: { icon: 'database', color: 'success' },
        preview: {
          title: '数据产物已就绪',
          subtitle: 'sales.xlsx · 456 行 · 6 列',
          note: '表格只给摘要，完整内容在对应应用里看。',
          columns: ['月份', '区域', '订单', '金额'],
          rows: [
            [{ text: '10 月' }, { text: '华东' }, { text: '128' }, { text: '¥86,400' }],
            [{ text: '10 月' }, { text: '华南' }, { text: '96' }, { text: '¥61,200' }],
            [{ text: '11 月' }, { text: '华东' }, { text: '74' }, { text: '¥52,900' }],
            [{ text: '合计', tone: 'muted' }, { text: '', tone: 'muted' }, { text: '298', tone: 'muted' }, { text: '¥200,500', tone: 'accent' }]
          ],
          actions: [
            { action: 'openInApp', label: '在 Mica 中打开', tone: 'primary' },
            { action: 'verify', label: '校验行数' }
          ]
        }
      }
    ]
  },
  {
    id: 'service',
    name: '服务已启动',
    kind: '本地服务',
    tone: 'green',
    note: '起完 dev server / 本地服务，给一个能点的入口；先看健康检查，再决定进不进内置浏览器。',
    message: '开发服务已在 3000 端口启动，健康检查通过。',
    buttons: [
      {
        label: '服务已启动',
        action: 'openService',
        style: { icon: 'server', color: 'success', shape: 'soft' },
        preview: {
          title: '本地服务正在运行',
          subtitle: 'http://127.0.0.1:3000 · 200 OK',
          text: '健康检查 /health 返回 200，页面响应 42ms。\n进内置浏览器打开可以直接操作，不必离开对话。',
          actions: [
            { action: 'browser', label: '在内置浏览器打开', tone: 'primary' },
            { action: 'copy', label: '复制地址' }
          ]
        }
      }
    ]
  },
  {
    id: 'verify',
    name: '验证结果',
    kind: '验证',
    tone: 'green',
    note: '测试、类型检查、构建成功后给一条可复核的结果；失败时同样的位置换成错误摘要与日志入口。',
    message: '`bun run typecheck` 与相关单测都通过了。',
    buttons: [
      {
        label: '测试通过',
        action: 'showResult',
        style: { icon: 'shield-check', color: 'success', shape: 'plain' },
        preview: {
          title: '验证结果',
          subtitle: '196 passed · 0 failed · 1.4s',
          markdown: '`bun run typecheck` — 通过\n`bun test plugin-panels` — 196 passed',
          actions: [{ action: 'log', label: '查看完整日志', tone: 'primary' }]
        }
      },
      {
        label: '构建产物',
        action: 'openBuild',
        style: { icon: 'package' },
        preview: {
          title: '构建完成',
          subtitle: 'out/renderer · 1.8 MB',
          text: '产物已写入 out/renderer，重启桌面端后生效。',
          actions: [{ action: 'reveal', label: '打开产物目录', tone: 'primary' }]
        }
      }
    ]
  },
  {
    id: 'decision',
    name: '需要决策',
    kind: '决策',
    tone: 'amber',
    note: '候选、风险这类必须在两个方案里选一个的，才用原来的 dialog 弹窗；只是「先看一眼」的仍旧走卡片。',
    message: '两种做法都可行，需要你定一下方向。',
    buttons: [
      {
        label: '两个方案',
        action: 'pick',
        style: { icon: 'list-checks', color: 'warn' },
        preview: {
          title: '先看一眼，再决定',
          subtitle: 'A 沿用当前方案 · B 先生成对比报告',
          text: 'A：改动小，今天就能合。\nB：多花一轮，但能先量出差异。',
          note: '选哪个都会先回一句结论，不满意再改。',
          actions: [
            { action: 'planA', label: '选 A', tone: 'primary' },
            { action: 'planB', label: '选 B' }
          ]
        }
      }
    ]
  },
  {
    id: 'look',
    name: '外观规格',
    kind: '外观',
    tone: 'default',
    note: '颜色、形状、纯图标都走主题令牌与同一套类名；一排里最多一两颗强调色，其余保持默认。',
    message: '同一排按钮的外观组合（都没有预览，悬停不会出卡片）。',
    buttons: [
      { label: '主操作', action: 'primary', style: { icon: 'zap', color: 'accent' } },
      { label: '危险', action: 'danger', style: { icon: 'eraser', color: 'danger' } },
      { label: '柔和', action: 'soft', style: { icon: 'tags', shape: 'soft' } },
      { label: '纯文字', action: 'plain', style: { shape: 'plain' } },
      { label: '只看日志', action: 'iconOnly', style: { icon: 'search', iconOnly: true } },
      { label: '终端', action: 'terminal', style: { icon: 'terminal', color: 'warn', shape: 'soft' } }
    ]
  }
]

function DemoQuickbar({ buttons, onAct, onOpenPreview, onLeaveButton, onEnterButton }) {
  const hoverTimer = useRef(0)

  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  const cancelHover = () => clearTimeout(hoverTimer.current)

  const hover = (event, button) => {
    if (!button.preview) return
    cancelHover()
    const rect = event.currentTarget.getBoundingClientRect()
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = 0
      onOpenPreview(button.preview, rect, 'hover')
    }, PREVIEW_HOVER_DELAY_MS)
  }

  return (
    <div
      className="chat-plugin-quickbar"
      role="toolbar"
      aria-label="插件快捷操作"
      onMouseLeave={() => {
        cancelHover()
        onLeaveButton()
      }}
    >
      {buttons.map((button) => {
        const look = quickbarButtonLook(button, { panelLabel: '演示' })
        return (
          <div
            className="chat-plugin-quickbar-group"
            key={`${button.action}:${button.label}`}
            onMouseEnter={(event) => {
              onEnterButton()
              hover(event, button)
            }}
          >
            <button
              type="button"
              className={look.className}
              title={look.title}
              aria-label={look.ariaLabel}
              onFocus={(event) => {
                if (!button.preview) return
                onOpenPreview(button.preview, event.currentTarget.getBoundingClientRect(), 'focus')
              }}
              onClick={() => {
                cancelHover()
                onAct(button.label)
              }}
            >
              {look.icon && <PluginIcon name={look.icon} size={13} />}
              {!look.iconOnly && button.label}
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** 演示文案里的反引号是「路径 / 命令」标记，渲染成行内代码，别把反引号当正文露出来。 */
function InlineText({ text }) {
  return text.split('`').map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : part))
}

export default function QuickButtonsPreviewDemo() {
  const [preview, setPreview] = useState(null)
  const [feedback, setFeedback] = useState('')
  const closeTimer = useRef(0)

  const closePreview = useCallback(() => {
    clearTimeout(closeTimer.current)
    setPreview(null)
  }, [])

  const openPreview = useCallback((next, rect, source) => {
    clearTimeout(closeTimer.current)
    setPreview({
      preview: next,
      source,
      anchor: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        right: Math.round(rect.right)
      }
    })
  }, [])

  // 与对话里一致：悬停打开的卡片，指针离开按钮一小会儿就收起；移到卡片上则保持。
  // 点击/键盘打开的不受这条规则管。
  const scheduleClose = useCallback(() => {
    if (preview?.source !== 'hover') return
    clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setPreview(null), 160)
  }, [preview])

  const cancelClose = useCallback(() => clearTimeout(closeTimer.current), [])

  useEffect(() => () => clearTimeout(closeTimer.current), [])

  return (
    // 组件库的样式与主题令牌都限定在 `.mica-config-ui` 作用域内，整页必须由它托管。
    <div className="mica-config-ui">
      <main className="content-shell quick-buttons-demo-shell">
        <PageFrame
          title="快捷按钮与预览卡片"
          description={`对话里出现的按钮与悬浮卡片就是这几个组件，这里把它们铺成场景对照形态。悬停 ${PREVIEW_HOVER_DELAY_MS}ms、点一下或用键盘聚焦都会展开卡片；Esc 或点空白处收起，滚动时自动关上。`}
          actions={feedback ? <Tag tone="blue">{feedback}</Tag> : null}
        >
          <div className="config-page-body">
            {SCENARIOS.map((scenario) => (
              <SettingsGroup
                key={scenario.id}
                title={scenario.name}
                description={scenario.note}
                actions={<Tag tone={scenario.tone}>{scenario.kind}</Tag>}
              >
                <SettingRow wide label="模型回复">
                  <p className="quick-buttons-demo-context">
                    <InlineText text={scenario.message} />
                  </p>
                </SettingRow>
                <SettingRow wide label="快捷按钮">
                  <DemoQuickbar
                    buttons={scenario.buttons}
                    onAct={(label) => setFeedback(`${label} · 已执行（演示，不写文件）`)}
                    onOpenPreview={openPreview}
                    onLeaveButton={scheduleClose}
                    onEnterButton={cancelClose}
                  />
                </SettingRow>
              </SettingsGroup>
            ))}
          </div>
        </PageFrame>
      </main>

      {preview && (
        <QuickbarPreview
          preview={preview.preview}
          anchor={preview.anchor}
          onClose={closePreview}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
          onRun={(action) => setFeedback(`${action.label} · 卡片动作（演示）`)}
        />
      )}
    </div>
  )
}
