import { expect, it } from 'vitest'
import { queuePluginLaunch, takePluginLaunch } from './plugin-launch'

it('hands one launch to the node that is about to mount', () => {
  expect(queuePluginLaunch('node-a', { prompt: '复盘', role: '需求开发' })).toBe(true)
  expect(takePluginLaunch('node-a')).toEqual({ prompt: '复盘', role: '需求开发' })
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
