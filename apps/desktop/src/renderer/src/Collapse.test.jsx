import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import Collapse from './Collapse'

/**
 * 折叠面（文件树目录、会话分组、侧栏分区）共用 `Collapse`。
 *
 * 这里钉两件在静态渲染下就能验证的事：收起时内容**不挂载**（文件树的懒加载靠它，
 * 否则整个 node_modules 都会在没有展开时先渲染出来），展开时带的是可过渡的那两层
 * 盒子。收起动画的延迟卸载与两帧展开走的是 effect，服务端渲染看不到。
 */
const RENDERER_DIR = resolve(dirname(fileURLToPath(import.meta.url)))
const appCss = readFileSync(resolve(RENDERER_DIR, '../assets/app.css'), 'utf8')

describe('Collapse', () => {
  it('展开时内容挂在可过渡的盒子里', () => {
    const html = renderToStaticMarkup(
      <Collapse open>
        <p>子目录</p>
      </Collapse>
    )
    expect(html).toContain('motion-collapse is-expanded')
    expect(html).toContain('motion-collapse-clip')
    expect(html).toContain('motion-collapse-body')
    expect(html).toContain('<p>子目录</p>')
  })

  it('收起时内容不挂载', () => {
    const html = renderToStaticMarkup(
      <Collapse open={false}>
        <p>子目录</p>
      </Collapse>
    )
    expect(html).toBe('')
  })

  it('展开状态不隐藏内容（aria-hidden 只在收起的那几帧出现）', () => {
    const html = renderToStaticMarkup(
      <Collapse open>
        <p>子目录</p>
      </Collapse>
    )
    expect(html).not.toContain('aria-hidden')
  })
})

describe('折叠的样式契约', () => {
  it('用 grid-template-rows 的两个端点，而不是固定高度', () => {
    expect(appCss).toMatch(/\.motion-collapse \{[^}]*grid-template-rows: 0fr/)
    expect(appCss).toMatch(/\.motion-collapse\.is-expanded \{[^}]*grid-template-rows: 1fr/)
    expect(appCss).toMatch(
      /transition: grid-template-rows var\(--motion-base\) var\(--ease-soft\)/
    )
  })

  it('裁剪层允许内容收缩，收起过程不接收点击', () => {
    expect(appCss).toMatch(/\.motion-collapse-clip \{[^}]*min-height: 0/)
    expect(appCss).toMatch(/\.motion-collapse-clip \{[^}]*overflow: hidden/)
    expect(appCss).toContain('.motion-collapse:not(.is-expanded) .motion-collapse-clip')
  })
})
