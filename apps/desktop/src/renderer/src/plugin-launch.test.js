import { expect, it, vi } from 'vitest'
import { queuePluginLaunch, subscribePluginLaunch, takePluginLaunch } from './plugin-launch'

it('hands one launch to the node that is about to mount', () => {
  expect(queuePluginLaunch('node-a', { prompt: '复盘', role: '需求开发' })).toBe(true)
  expect(takePluginLaunch('node-a')).toEqual({ prompt: '复盘', role: '需求开发', send: true })
})

it('takes it once only', () => {
  queuePluginLaunch('node-b', { prompt: '看群' })
  takePluginLaunch('node-b')
  expect(takePluginLaunch('node-b')).toBeNull()
})

it('never queues an empty task', () => {
  expect(queuePluginLaunch('node-c', { prompt: '   ' })).toBe(false)
  expect(queuePluginLaunch('', { prompt: 'x' })).toBe(false)
  expect(takePluginLaunch('node-c')).toBeNull()
})

it('keeps "只放进输入框" as send: false and defaults everything else to send', () => {
  queuePluginLaunch('node-d', { prompt: '去更新页面', send: false })
  expect(takePluginLaunch('node-d')).toEqual({ prompt: '去更新页面', role: '', send: false })
})

it('tells the mounted view when a launch arrives for it', () => {
  // 复用到已有的空草稿时目标节点已经挂着，不会重新挂载——靠这条通知才取得走。
  const seen = []
  const off = subscribePluginLaunch((nodeId) => seen.push(nodeId))
  queuePluginLaunch('node-e', { prompt: '去更新页面', send: false })
  expect(seen).toEqual(['node-e'])
  off()
  queuePluginLaunch('node-f', { prompt: '不该再来' })
  expect(seen).toEqual(['node-e'])
  takePluginLaunch('node-f')
})

it('does not let a broken listener swallow the launch', () => {
  const off = subscribePluginLaunch(() => {
    throw new Error('boom')
  })
  expect(() => queuePluginLaunch('node-g', { prompt: '仍然要交接' })).not.toThrow()
  off()
  expect(takePluginLaunch('node-g')?.prompt).toBe('仍然要交接')
})

it('keeps listeners isolated from each other', () => {
  const first = vi.fn()
  const second = vi.fn()
  const offFirst = subscribePluginLaunch(first)
  const offSecond = subscribePluginLaunch(second)
  queuePluginLaunch('node-h', { prompt: '两边都要收到' })
  expect(first).toHaveBeenCalledWith('node-h')
  expect(second).toHaveBeenCalledWith('node-h')
  offFirst()
  offSecond()
  takePluginLaunch('node-h')
})
