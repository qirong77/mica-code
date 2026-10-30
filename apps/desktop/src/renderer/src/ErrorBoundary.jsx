import { Component } from 'react'

/**
 * 渲染兜底。
 *
 * React 的默认行为是：任何一处 render 抛错就把整棵树卸掉。页面因此变成一整块纯黑——
 * 只剩窗口按钮，既没有报错也没有入口，用户只能强退（2026-10 就撞到过一次：
 * App 里一个变量在声明前被引用）。所以根节点必须有一层边界：把错误留在页面上，
 * 给出可读信息、重载与复制入口，至少还能自救和反馈。
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // 控制台仍然要留完整堆栈：页面上的信息要短，调试的人需要全量。
    console.error('[mica] 界面渲染失败', error, info?.componentStack || '')
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return <AppCrashNotice error={error} />
  }
}

function detailsOf(error) {
  if (error instanceof Error) {
    return [error.message, error.stack].filter(Boolean).join('\n\n')
  }
  return String(error ?? '未知错误')
}

/** 出错时页面上留下的那一屏（与 App 无关，所以不依赖任何界面状态）。 */
export function AppCrashNotice({ error }) {
  const details = detailsOf(error)
  const reload = () => window.location.reload()
  const copy = () => {
    navigator.clipboard?.writeText(details).catch(() => {})
  }
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center">
      <div className="text-sm text-fg-strong">界面渲染失败</div>
      <div className="max-w-xl text-xs leading-relaxed text-fg-muted">
        这不是网络问题：页面在渲染时抛了异常。重新加载通常能恢复；如果反复出现，把下面的详情发出来。
      </div>
      <pre className="max-h-64 w-full max-w-xl overflow-auto rounded-lg border border-line bg-overlay-subtle p-3 text-left text-[11px] leading-relaxed text-fg-soft">
        {details}
      </pre>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded-md border border-line px-3 py-1 text-xs text-fg-strong transition-colors hover:bg-overlay"
          onClick={reload}
        >
          重新加载
        </button>
        <button
          type="button"
          className="rounded-md border border-line px-3 py-1 text-xs text-fg-soft transition-colors hover:bg-overlay"
          onClick={copy}
        >
          复制详情
        </button>
      </div>
    </div>
  )
}
