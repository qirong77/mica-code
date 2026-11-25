import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Globe } from 'lucide-react'
import { MenuItem, MenuList } from '@mica-config-ui/menu'
import { compactUrl } from '@packages/mica-web-shared'
import { post } from './bridge'

/**
 * 「最近访问」浮层的内容。它单独占一个窗口（见 main/browser/browser-recents-window.js），
 * 只负责画：列表和高亮由顶栏按输入筛好推过来，选中也回给主进程去导航——这里不持有
 * 浏览器状态，窗口销毁重建也不会丢任何东西。
 *
 * 行就是组件库的菜单项（`@mica-config-ui/menu` 的 `MenuList` / `MenuItem`，与设置页的
 * 菜单、顶栏的窗口下拉是同一个组件和同一份 `.mica-menu` 样式）：单行、16px 图标位、
 * 32px 行高、6px 圆角高亮。窗口高度由主进程按这几个尺寸算
 * （`main/browser/browser-recents.js` 的 `RECENT_ROW_HEIGHT` / `RECENT_PAD`），
 * 改组件库的尺寸要两边一起改。
 *
 * 行用 `onMouseDown` 选取：浮层不是 key window，不能让「先失焦再点」的默认顺序把点击吞掉。
 */
export function Recent({ store }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const items = Array.isArray(state.items) ? state.items : []
  const highlight = Number.isInteger(state.highlight) ? state.highlight : -1
  const listRef = useRef(null)

  useEffect(() => {
    const active = listRef.current?.querySelector('.recent-item.active')
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' })
    }
  }, [highlight, items])

  return (
    <MenuList className="recent-menu" aria-label="最近访问" ref={listRef}>
      {items.map((item, index) => {
        const active = index === highlight
        return (
          <MenuItem
            key={item.url}
            className={active ? 'recent-item active' : 'recent-item'}
            title={item.url}
            aria-current={active ? 'true' : undefined}
            // 行在另一个窗口里：鼠标划过要把高亮同步回地址框，回车与点选才是同一条
            onMouseEnter={() => post('recent:hover', { index })}
            onMouseDown={(event) => {
              event.preventDefault()
              post('recent:pick', { url: item.url })
            }}
            icon={
              typeof item.favicon === 'string' && item.favicon ? (
                <img className="recent-favicon" src={item.favicon} alt="" />
              ) : (
                <Globe className="recent-favicon-fallback" size={14} aria-hidden="true" />
              )
            }
          >
            {/* 标题与地址同一行：标题能重复（同一个站点的不同页面），地址才是唯一线索 */}
            <span className="recent-title">{item.title || compactUrl(item.url)}</span>
            <span className="recent-url">{compactUrl(item.url)}</span>
          </MenuItem>
        )
      })}
    </MenuList>
  )
}
