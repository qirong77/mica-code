import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppCrashNotice, ErrorBoundary } from './ErrorBoundary'

/**
 * 兜底页是「黑屏」这条路上的最后一道视觉：它必须带出错误本身，否则用户只知道坏了。
 */
describe('AppCrashNotice', () => {
  test('renders the message and stack of an Error', () => {
    const html = renderToStaticMarkup(
      createElement(AppCrashNotice, { error: new Error('boom-xyz') })
    )
    expect(html).toContain('界面渲染失败')
    expect(html).toContain('boom-xyz')
    expect(html).toContain('重新加载')
    expect(html).toContain('复制详情')
  })

  test('falls back to a readable string for non-Error values', () => {
    const html = renderToStaticMarkup(createElement(AppCrashNotice, { error: 'plain-failure' }))
    expect(html).toContain('plain-failure')
  })
})

describe('ErrorBoundary', () => {
  test('starts transparent so normal children render untouched', () => {
    const html = renderToStaticMarkup(
      createElement(ErrorBoundary, null, createElement('div', null, 'ok-child'))
    )
    expect(html).toBe('<div>ok-child</div>')
  })

  test('turns a render error into the notice instead of throwing', () => {
    const boundary = new ErrorBoundary({ children: null })
    expect(boundary.state.error).toBeNull()
    const error = new Error('caught-by-boundary')
    expect(ErrorBoundary.getDerivedStateFromError(error)).toEqual({ error })
    // 未出错时原样透传 children：边界不能改变正常路径的渲染结果
    expect(boundary.render()).toBeNull()
    boundary.state = { error }
    const html = renderToStaticMarkup(boundary.render())
    expect(html).toContain('caught-by-boundary')
  })
})
