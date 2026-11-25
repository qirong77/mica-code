import { useEffect, useRef, useSyncExternalStore } from 'react'
import { compactUrl } from '@packages/mica-web-shared'
import { post } from './bridge'

/**
 * 「最近访问」浮层的内容。它单独占一个窗口（见 main/browser/browser-recents-window.js），
 * 只负责画：列表和高亮由顶栏按输入筛好推过来，选中也回给主进程去导航——这里不持有
 * 浏览器状态，窗口销毁重建也不会丢任何东西。
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
    <div className="recent-panel">
      <div className="recent-list" ref={listRef} role="listbox" aria-label="最近访问">
        {items.map((item, index) => (
          <button
            key={item.url}
            type="button"
            role="option"
            aria-selected={index === highlight}
            className={index === highlight ? 'recent-item active' : 'recent-item'}
            title={item.url}
            onMouseEnter={() => post('recent:hover', { index })}
            onMouseDown={(event) => {
              event.preventDefault()
              post('recent:pick', { url: item.url })
            }}
          >
            <span className="recent-item-title">{item.title || compactUrl(item.url)}</span>
            <span className="recent-item-url">{compactUrl(item.url)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
