import { describe, expect, it } from 'bun:test'
import { createSubagentDisplay } from './chat-subagent-display'

describe('subagent display lifecycle', () => {
  it('只往页面推运行中的行', () => {
    const display = createSubagentDisplay()
    const failed = { taskId: 'failed', status: 'failed' }
    const running = { taskId: 'running', status: 'running' }
    expect(display.update([failed, running])).toEqual([running])
    expect(display.update([failed])).toEqual([])
  })

  it('一轮成功结束时清空这一轮露过面的行', () => {
    const display = createSubagentDisplay()
    const running = { taskId: 'running', status: 'running' }
    display.update([running])
    expect(display.finish('turn-1', 'turn-1', 'completed')).toEqual([])
    // 收尾之后同一个任务要是真的又跑起来（重启出的新任务 id 不同），照旧显示。
    expect(display.update([running])).toEqual([running])
  })

  it('只有当前这一轮以完成收尾才清空', () => {
    const display = createSubagentDisplay()
    display.update([{ taskId: 'task', status: 'running' }])
    expect(display.finish('new', 'old', 'completed')).toBeNull()
    expect(display.finish('new', 'new', 'error')).toBeNull()
    expect(display.finish('new', 'new', 'aborted')).toBeNull()
  })
})
