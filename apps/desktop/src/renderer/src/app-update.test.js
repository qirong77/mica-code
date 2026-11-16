import assert from 'node:assert/strict'
import { test } from 'bun:test'
import {
  preserveNativeStatus,
  runNativeUpdate,
  updateButtonState,
  updateCheckUrl
} from './app-update.js'

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

test('shows immediate checking and error states without inventing an empty action', () => {
  assert.deepEqual(updateButtonState(null, { status: 'checking' }), {
    visible: true,
    label: '检查更新…',
    tone: 'primary'
  })
  assert.deepEqual(updateButtonState(null, { status: 'error', error: 'IPC failed' }), {
    visible: true,
    label: '更新失败',
    tone: 'primary'
  })
  assert.equal(updateButtonState(null, { status: 'unsupported' }).visible, false)
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

test('a click that discovers an available native update immediately starts downloading', async () => {
  const calls = []
  const phases = []
  const outcome = await runNativeUpdate({
    bridge: {
      async check() {
        calls.push('check')
        return { ok: true, status: { status: 'available', version: '1.0.2' } }
      },
      async download() {
        calls.push('download')
        return { ok: true, status: { status: 'downloading', progress: 0 } }
      }
    },
    onStatus: (status) => phases.push(status.status)
  })
  assert.deepEqual(calls, ['check', 'download'])
  assert.deepEqual(phases, ['checking', 'available', 'downloading', 'downloading'])
  assert.equal(outcome.kind, 'download')
  assert.equal(outcome.result.ok, true)
})

test('a downloaded native package goes straight to install and preserves failures', async () => {
  const calls = []
  const outcome = await runNativeUpdate({
    currentStatus: 'downloaded',
    bridge: {
      async install() {
        calls.push('install')
        return { ok: false, code: 'busy', error: '会话仍在运行' }
      }
    }
  })
  assert.deepEqual(calls, ['install'])
  assert.equal(outcome.kind, 'install')
  assert.equal(outcome.result.ok, false)
  assert.equal(outcome.result.code, 'busy')
})

test('IPC rejection is returned as a visible native failure', async () => {
  const outcome = await runNativeUpdate({
    bridge: {
      async check() {
        throw new Error('bridge disconnected')
      }
    }
  })
  assert.equal(outcome.kind, 'error')
  assert.equal(outcome.result.ok, false)
  assert.equal(outcome.result.rejected, true)
  assert.equal(outcome.result.error, 'bridge disconnected')
})

test('status polling cannot downgrade a package that is downloading or downloaded', () => {
  const downloading = { status: 'downloading', progress: 60 }
  const downloaded = { status: 'downloaded', progress: 100 }
  assert.equal(preserveNativeStatus(downloading, { status: 'not-available' }), downloading)
  assert.equal(preserveNativeStatus(downloaded, { status: 'checking' }), downloaded)
  assert.deepEqual(preserveNativeStatus(downloaded, { status: 'installing' }), { status: 'installing' })
})

test('failure envelopes and missing methods cannot leave the action stuck checking or downloading', async () => {
  for (const code of ['unsupported', 'remote-window', 'network']) {
    const phases = []
    const outcome = await runNativeUpdate({
      bridge: { check: async () => ({ ok: false, code, error: 'unavailable' }) },
      onStatus: (status) => phases.push(status.status)
    })
    assert.equal(outcome.kind, code === 'network' ? 'error' : 'source')
    assert.equal(phases.at(-1), code === 'network' ? 'error' : 'unsupported')
  }
  for (const bridge of [{}, { download: async () => ({ ok: false, error: 'offline' }) }]) {
    const phases = []
    await runNativeUpdate({ bridge, currentStatus: 'available', onStatus: (status) => phases.push(status.status) })
    assert.equal(phases.at(-1), 'error')
  }
})

test('browser pages explain their installer boundary instead of pretending to be a source checkout', async () => {
  assert.equal((await runNativeUpdate({})).reason, 'browser')
})
