import { beforeEach, describe, expect, test } from 'bun:test'
import {
  clearNotifications,
  dismissNotification,
  getNotifications,
  notify,
  subscribeNotifications
} from './notify'

beforeEach(() => {
  clearNotifications()
})

describe('notify', () => {
  test('没有 key 的通知各自排队', () => {
    notify({ text: '第一条' })
    notify({ text: '第二条' })
    expect(getNotifications().map((item) => item.text)).toEqual(['第一条', '第二条'])
  })

  test('同 key 原地更新，不叠加，位置不变', () => {
    notify({ key: 'build', text: '构建中 · 3s' })
    notify({ text: '另一条' })
    notify({ key: 'build', text: '构建中 · 2s' })

    const items = getNotifications()
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ key: 'build', text: '构建中 · 2s' })
    expect(items[1].text).toBe('另一条')
  })

  test('队列最多三条，先淘汰最旧的非置顶项', () => {
    notify({ text: 'a' })
    notify({ text: 'b' })
    notify({ text: 'c', sticky: true })
    notify({ text: 'd' })

    const texts = getNotifications().map((item) => item.text)
    expect(texts).toHaveLength(3)
    expect(texts).not.toContain('a')
    expect(texts).toContain('c')
    expect(texts).toContain('d')
  })

  test('置顶项排到最前面', () => {
    notify({ text: '普通' })
    notify({ text: '紧急', sticky: true })
    expect(getNotifications().map((item) => item.text)).toEqual(['紧急', '普通'])
  })

  test('id 与 key 都能用来关闭', () => {
    const id = notify({ text: '带 id' })
    notify({ key: 'build', text: '带 key' })

    dismissNotification(id)
    expect(getNotifications().map((item) => item.text)).toEqual(['带 key'])

    dismissNotification('build')
    expect(getNotifications()).toHaveLength(0)
  })

  test('订阅者拿到新队列，取消后不再收到', () => {
    const seen = []
    const off = subscribeNotifications((items) => seen.push(items.map((item) => item.text)))
    notify({ text: '一' })
    off()
    notify({ text: '二' })

    expect(seen).toEqual([['一']])
  })

})
