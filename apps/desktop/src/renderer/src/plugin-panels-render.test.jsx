import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PluginPanelSection } from './PluginPanels'

const render = (section) =>
  renderToStaticMarkup(
    <PluginPanelSection
      section={section}
      tabbed
      focused
      drafts={{}}
      setDrafts={() => {}}
      busy=""
      runAction={() => {}}
    />
  )

/**
 * 分区里的每个动作按钮都要拿到自己的 `action`。
 *
 * 漏传时 `action.icon` 直接抛 TypeError，整块面板变成「界面渲染失败」——这不是某个
 * 插件的数据问题，是渲染路径自己的 bug，所以在这里把四种挂动作的位置都画一遍。
 */
describe('插件面板分区渲染', () => {
  test('条目行尾的图标动作画出图标而不是崩溃', () => {
    const html = render({
      title: '频道',
      items: [
        {
          key: 'channel-1',
          label: '项目群',
          value: '群 · 项目群',
          actions: [{ id: 'channel.remove', label: '删除', icon: 'trash', tone: 'danger' }]
        }
      ]
    })
    expect(html).toContain('项目群')
    expect(html).toContain('删除')
  })

  test('分区底部的动作带文字', () => {
    const html = render({
      title: '频道',
      actions: [{ id: 'channel.sync', label: '同步频道' }]
    })
    expect(html).toContain('同步频道')
  })

  test('表格行尾的动作只画图标', () => {
    const html = render({
      title: '环境',
      table: {
        columns: [{ key: 'name', label: '名称' }],
        rows: [
          {
            key: 'row-1',
            cells: { name: { text: 'PRD' } },
            actions: [{ id: 'env.remove', label: '删除', icon: 'trash', tone: 'danger' }]
          }
        ]
      }
    })
    expect(html).toContain('PRD')
    expect(html).toContain('删除')
  })

  test('输入框行尾的提交动作', () => {
    const html = render({
      title: '频道',
      fields: [
        {
          key: 'channel',
          label: '新增频道',
          action: { id: 'channel.add', label: '添加频道', icon: 'plus' }
        }
      ]
    })
    expect(html).toContain('新增频道')
    expect(html).toContain('添加频道')
  })
})
