import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'
import { countUpdateLeases, updateActivityBlockers } from './update-activity.js'

const ZERO_ACTIVITY = {
  ok: true,
  chats: 0,
  commits: 0,
  terminals: 0,
  browsers: 0,
  editors: 0,
  unsaved: 0
}

test('counts live update leases without treating missing, dead, or corrupt locks as idle', () => {
  const root = mkdtempSync(join(tmpdir(), 'mica-update-activity-'))
  const locks = join(root, 'locks')
  mkdirSync(locks)
  try {
    writeFileSync(join(locks, 'alive.lock'), JSON.stringify({ pid: process.pid }), 'utf8')
    writeFileSync(join(locks, 'dead.lock'), JSON.stringify({ pid: 2 ** 31 - 1 }), 'utf8')
    writeFileSync(join(locks, 'not-a-lock.txt'), JSON.stringify({ pid: process.pid }), 'utf8')
    assert.equal(countUpdateLeases(locks), 1)

    rmSync(join(locks, 'alive.lock'))
    assert.equal(countUpdateLeases(locks), 0)
    assert.equal(countUpdateLeases(join(root, 'missing')), 0)

    writeFileSync(join(locks, 'corrupt.lock'), '{not json', 'utf8')
    assert.throws(() => countUpdateLeases(locks), /会话锁正在写入或无法读取，请稍后重试/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects an activity snapshot when any required count is missing, NaN, or negative', () => {
  for (const kind of ['chats', 'commits', 'terminals', 'browsers', 'editors', 'unsaved']) {
    const missing = { ...ZERO_ACTIVITY }
    delete missing[kind]
    assert.throws(() => updateActivityBlockers(missing), new RegExp(`工作状态缺少 ${kind}`))

    assert.throws(() => updateActivityBlockers({ ...ZERO_ACTIVITY, [kind]: Number.NaN }), new RegExp(`工作状态缺少 ${kind}`))
    assert.throws(() => updateActivityBlockers({ ...ZERO_ACTIVITY, [kind]: -1 }), new RegExp(`工作状态缺少 ${kind}`))
  }
  assert.throws(() => updateActivityBlockers({ ...ZERO_ACTIVITY, ok: false }), /工作状态返回不完整/)
})

test('returns no blockers only for a complete all-zero activity snapshot', () => {
  assert.deepEqual(updateActivityBlockers(ZERO_ACTIVITY), [])
})

test('gives every non-zero activity type an explicit human-readable blocking reason', () => {
  const activity = {
    ...ZERO_ACTIVITY,
    chats: 1,
    commits: 2,
    terminals: 3,
    browsers: 4,
    editors: 5,
    unsaved: 6
  }
  const blockers = updateActivityBlockers(activity)
  assert.deepEqual(blockers.map(({ kind, count }) => [kind, count]), [
    ['chats', 1],
    ['commits', 2],
    ['terminals', 3],
    ['browsers', 4],
    ['editors', 5],
    ['unsaved', 6]
  ])
  for (const blocker of blockers) {
    assert.equal(typeof blocker.label, 'string')
    assert.ok(blocker.label.length > 0)
    assert.match(blocker.label, /有 \d+/)
  }
  assert.match(blockers.find((item) => item.kind === 'chats').label, /会话或后台任务/)
  assert.match(blockers.find((item) => item.kind === 'commits').label, /提交任务/)
  assert.match(blockers.find((item) => item.kind === 'terminals').label, /终端/)
  assert.match(blockers.find((item) => item.kind === 'browsers').label, /受控浏览器/)
  assert.match(blockers.find((item) => item.kind === 'editors').label, /独立编辑器/)
  assert.match(blockers.find((item) => item.kind === 'unsaved').label, /未保存或正在保存/)
})
