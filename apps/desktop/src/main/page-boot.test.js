import { describe, expect, test } from 'bun:test'
import { PAGE_STATE_PROBE, createBootGuard } from './page-boot.js'

/** 在假 DOM 上跑一次探测脚本：这里只验判定，不验真实 Chromium 行为。 */
function runProbe({ mica = false, rootChildren = 0, text = '', body = true } = {}) {
  const document = {
    body: body ? { innerText: text } : undefined,
    getElementById: () => (rootChildren ? { children: new Array(rootChildren) } : null)
  }
  const window = mica ? { mica: {} } : {}
  return new Function('window', 'document', `return ${PAGE_STATE_PROBE}`)(window, document)
}

describe('PAGE_STATE_PROBE', () => {
  test('装上 window.mica 就算起来了', () => {
    expect(runProbe({ mica: true })).toBe('booted')
  })

  test('Mica 自己的报错页（#root 有内容）算页面在显示东西', () => {
    expect(runProbe({ rootChildren: 2, text: '运行时没起来' })).toBe('page')
  })

  test('没有 #root 但自己渲染了文本的静态页也算页面', () => {
    // 中转机在目标机器离线时给的就是这一页：不是 Mica 页面，但自己把状况写清楚了
    expect(runProbe({ text: '这台机器当前没有连上中转机' })).toBe('page')
  })

  test('什么都没有才是空白', () => {
    expect(runProbe({ text: '   ' })).toBe('blank')
    expect(runProbe({ body: false })).toBe('blank')
  })
})

describe('createBootGuard', () => {
  test('同一个地址只重载一次、只提示一次', () => {
    const guard = createBootGuard()
    expect(guard.next('https://a/?t=x')).toBe('reload')
    expect(guard.next('https://a/?t=x')).toBe('report')
    expect(guard.next('https://a/?t=x')).toBe('ignore')
    expect(guard.next('https://a/?t=x')).toBe('ignore')
  })

  test('换个地址（同一台机器的另一个会话）重新有额度', () => {
    const guard = createBootGuard()
    expect(guard.next('https://a/?t=x&session=1')).toBe('reload')
    expect(guard.next('https://a/?t=x&session=2')).toBe('reload')
    expect(guard.next('https://a/?t=x&session=1')).toBe('report')
    expect(guard.next('https://a/?t=x&session=2')).toBe('report')
  })

  test('页面起来之后额度还回去', () => {
    const guard = createBootGuard()
    expect(guard.next('https://a/')).toBe('reload')
    expect(guard.next('https://a/')).toBe('report')
    guard.recovered()
    expect(guard.next('https://a/')).toBe('reload')
  })

  test('没有地址时什么都不做', () => {
    const guard = createBootGuard()
    expect(guard.next('')).toBe('ignore')
  })
})
