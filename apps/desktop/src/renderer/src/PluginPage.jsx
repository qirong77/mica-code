import { Suspense, useMemo } from 'react'
import { IconArrowLeft } from '@tabler/icons-react'
import { createPluginHostApi } from './plugin-host'
import { useIsMobile } from './hooks'

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
  const api = useMemo(() => createPluginHostApi(entry.id), [entry.id])
  const Page = entry.module.Page ?? entry.module.default

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
          <button
            type="button"
            title="返回对话"
            aria-label="返回对话"
            className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-white/50 transition-colors hover:bg-white/[.06] hover:text-white"
            onClick={onClose}
          >
            <IconArrowLeft size={13} />
            <span className="text-xs">返回对话</span>
          </button>
          <span className="min-w-0 truncate text-xs font-medium text-white/75">
            {entry.page.title || entry.label}
          </span>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          <Suspense
            fallback={
              <div className="grid h-full place-items-center text-xs text-white/40">正在加载…</div>
            }
          >
            <Page api={api} onClose={onClose} />
          </Suspense>
        </div>
      </div>
    </div>
  )
}
