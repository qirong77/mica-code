import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPanelTiming } from './panel-timing'

test('panel timing records bounded, anonymous slow dispatch stages', () => {
  let time = 0
  const records = []
  const timing = createPanelTiming({ now: () => time, log: (record) => records.push(record) })
  let measure = timing.start()
  time = 20
  let finish = measure.dispatched({ firstHostOutputAt: 200 }, false)
  time = 600
  finish(true)
  assert.deepEqual(records, [
    {
      host: 'spawned',
      preparationMs: 20,
      roundTripMs: 580,
      firstOutputWaitMs: 180,
      ok: true,
      suppressed: 0
    }
  ])

  time = 700
  measure = timing.start()
  finish = measure.dispatched({}, true)
  time = 1300
  finish(false)
  assert.equal(records.length, 1)

  time = 11000
  measure = timing.start()
  time = 11010
  finish = measure.dispatched({ firstHostOutputAt: 500 }, true)
  time = 11550
  finish(false)
  assert.deepEqual(records[1], {
    host: 'existing',
    preparationMs: 10,
    roundTripMs: 540,
    firstOutputWaitMs: 0,
    ok: false,
    suppressed: 1
  })
})

test('fast requests are silent and missing host output remains unknown', () => {
  let time = 0
  const records = []
  const timing = createPanelTiming({ now: () => time, log: (record) => records.push(record) })
  let finish = timing.start().dispatched(null, false)
  time = 499
  finish(false)
  assert.equal(records.length, 0)
  finish = timing.start().dispatched(null, false)
  time = 1000
  finish(false)
  assert.equal(records[0].firstOutputWaitMs, null)
  assert.equal(records[0].ok, false)
})
