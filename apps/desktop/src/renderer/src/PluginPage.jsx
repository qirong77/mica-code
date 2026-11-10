import { ArcoAction } from '@mica-config-ui/web'
import { Suspense, useMemo, useRef } from 'react'
import { IconArrowLeft } from '@tabler/icons-react'
import { createPluginHostApi } from './plugin-host'
import { useIsMobile } from './hooks'
import { notify } from './notify'

/**
 * 插件整页（清单 `desktop.page`）。
 *
 * 宿主只画外面这层壳：拖动条、返回、标题，以及把 `api` 交给插件自己的 `Page` 组件。
 * 与配置页同一套做法——盖住整个窗口、左上角一个返回——因为整页的用途就是要宽度和高度
 * （时间轴、表格），塞进对话区右侧只会把它挤成鸡肋。
 *
 * 这里不认识任何具体插件：页面标题来自清单，内容来自插件目录的 `desktop.jsx`。
 */
export function PluginPage({ entry, onClose }) {
  const isMobile = useIsMobile()
  const beforeClose = useMemo(() => new Set(), [entry.id])
  const closing = useRef(false)
  const api = useMemo(() => ({
    ...createPluginHostApi(entry.id),
    page: {
      beforeClose(handler) {
        beforeClose.add(handler)
        return () => beforeClose.delete(handler)
      }
    }
  }), [entry.id, beforeClose])
  const Page = entry.module.Page ?? entry.module.default
  const close = async () => {
    if (closing.current) return
    closing.current = true
    try {
      for (const handler of beforeClose) if ((await handler()) === false) return
      onClose()
    } catch (error) {
      notify({ key: `plugin-page-close:${entry.id}`, text: '页面暂时无法关闭', detail: error?.message || String(error), level: 'error' })
    } finally { closing.current = false }
  }

  return (
    <div className="fixed inset-0 z-[9500] flex flex-col bg-canvas">
      {/* 桌面端留一条拖动条：整页盖住窗口后没有别处可以拖（macOS 的交通灯由系统画在
          页面之上，不受这层影响）。 */}
      {!isMobile && (
        <div
          className="drag-region h-8 shrink-0 border-b border-line bg-panel"
          aria-hidden="true"
        />
      )}
      <div className="no-drag flex min-h-0 flex-1 flex-col">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
          <ArcoAction
            type="button"
            title="返回对话"
            aria-label="返回对话"
            className="flex h-6 shrink-0 items-center gap-1 px-1.5 transition-colors "
            onClick={close}
          >
            <IconArrowLeft size={13} />
            <span className="text-xs">返回对话</span>
          </ArcoAction>
          <span className="min-w-0 truncate text-xs font-medium text-fg-strong">
            {entry.page.title || entry.label}
          </span>
        </header>
        {/* 插件页面与设置页共用同一套控件（`@mica-config-ui/web`），那些样式限定在
            `.mica-config-ui` 作用域内，所以整页内容外面必须套这一层。`is-fill` 让它
            占满剩下的高度，时间轴这类要整块空间的界面才铺得开。 */}
        <div className="mica-config-ui is-embed is-fill min-h-0 flex-1 overflow-hidden">
          <Suspense
            fallback={
              <div className="grid h-full place-items-center text-xs text-fg-muted">正在加载…</div>
            }
          >
            <Page api={api} onClose={close} />
          </Suspense>
        </div>
      </div>
    </div>
  )
}
