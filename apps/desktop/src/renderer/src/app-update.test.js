import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { updateButtonState, updateCheckUrl } from './app-update.js'

test('shows a left-footer action for a discovered source update', () => {
  assert.deepEqual(updateButtonState({ available: true }, null), {
    visible: true,
    label: '有新版本',
    tone: 'primary'
  })
})

test('native downloaded state takes precedence over the source commit hint', () => {
  assert.deepEqual(updateButtonState({ available: true }, { status: 'downloaded' }), {
    visible: true,
    label: '重启更新',
    tone: 'primary'
  })
  assert.deepEqual(updateButtonState(null, { status: 'downloading', progress: 42.4 }), {
    visible: true,
    label: '下载更新 42%',
    tone: 'primary'
  })
})

test('does not leave an empty footer action when nothing is newer', () => {
  assert.deepEqual(updateButtonState({ available: false }, { status: 'not-available' }), {
    visible: false,
    label: '',
    tone: undefined
  })
  assert.equal(updateCheckUrl(), '/api/update/check')
  assert.equal(updateCheckUrl(true), '/api/update/check?force=1')
})
