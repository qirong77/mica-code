import { Component } from 'react'

/**
 * 顶栏 / 浮层的渲染兜底。
 *
 * 不复用主应用的 `ErrorBoundary`：那个带着整套界面样式（Tailwind + 配置页组件），
 * 为了一个 38px 的工具条把几百 KB 样式拖进来不值。这里只留一行能读的错误——页面真崩了，
 * 至少还能看出是崩了，而不是一条凭空消失的灰条。
 */
export class Boundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[mica-browser-chrome] 界面渲染失败', error, info?.componentStack || '')
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return <div className="chrome-crash">界面渲染失败：{String(error?.message || error)}</div>
  }
}
