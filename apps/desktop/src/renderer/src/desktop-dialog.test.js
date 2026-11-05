import { describe, expect, test } from 'bun:test'
import { alertAction, confirmAction, desktopDialogStore } from './desktop-dialog.jsx'

describe('desktop dialogs', () => {
  test('queues confirmations and settles cancellation before the next request', async () => {
    const first = confirmAction('删除文件？')
    const second = confirmAction('关闭窗口？')
    expect(desktopDialogStore.getSnapshot()).toMatchObject({ message: '删除文件？', danger: true })
    desktopDialogStore.settle(false)
    expect(await first).toBe(false)
    expect(desktopDialogStore.getSnapshot().message).toBe('关闭窗口？')
    desktopDialogStore.settle(true)
    expect(await second).toBe(true)
    expect(desktopDialogStore.getSnapshot()).toBeNull()
  })

  test('alert resolves without exposing a confirmation result', async () => {
    const result = alertAction('操作失败')
    expect(desktopDialogStore.getSnapshot()).toMatchObject({ message: '操作失败', cancelText: '' })
    desktopDialogStore.settle(false)
    expect(await result).toBeUndefined()
  })
})
