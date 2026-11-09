import { Component, forwardRef, lazy } from 'react'
import { ArcoAction } from '@mica-config-ui/web'

/** Keep a missing named export out of React.lazy's cached resolved state (#306). */
export async function loadView(loader, name) {
  const module = await loader()
  const view = module?.[name]
  const kind = view?.$$typeof
  if (
    typeof view !== 'function' &&
    kind !== Symbol.for('react.forward_ref') &&
    kind !== Symbol.for('react.memo')
  ) {
    throw new Error(
      `无法加载视图 ${name}：模块未提供有效组件（导出：${Object.keys(module || {}).join(', ') || '无'}）`
    )
  }
  return { default: view }
}

class ViewBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, View: props.resource.current }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error(`[mica] 视图加载失败 ${this.props.name}`, error, info?.componentStack || '')
  }

  retry = () => {
    // React.lazy caches rejected promises. A retry needs a new lazy type as well as a reset boundary.
    this.setState({ error: null, View: this.props.resource.retry() })
  }

  render() {
    const { error, View } = this.state
    if (error) {
      if (this.props.viewProps.visible === false) return null
      return (
        <div
          role="alert"
          className={`flex flex-col items-center justify-center gap-2 bg-panel p-4 text-xs text-fg-muted ${this.props.overlay ? 'fixed inset-0 z-[10000]' : ''}`}
        >
          <span>此视图加载失败，请重试。</span>
          <ArcoAction className="px-3 py-1" onClick={this.retry}>
            重试加载
          </ArcoAction>
          {this.props.viewProps.onClose && (
            <ArcoAction onClick={this.props.viewProps.onClose}>
              关闭
            </ArcoAction>
          )}
        </div>
      )
    }
    return <View {...this.props.viewProps} ref={this.props.viewRef} />
  }
}

/** Define once at module scope; keep each instance's failures and retries local. */
export function lazyView(loader, name, { overlay = false } = {}) {
  // Initial suspense can discard an uncommitted boundary. Keep this type stable
  // across those mounts, or every retry creates another pending promise forever.
  const resource = {
    current: lazy(() => loadView(loader, name)),
    retry() {
      this.current = lazy(() => loadView(loader, name))
      return this.current
    }
  }
  const View = forwardRef(function LazyView(props, ref) {
    return (
      <ViewBoundary
        loader={loader}
        name={name}
        resource={resource}
        overlay={overlay}
        viewProps={props}
        viewRef={ref}
      />
    )
  })
  View.displayName = `LazyView(${name})`
  return View
}
