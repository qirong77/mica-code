import { describe, expect, it, beforeEach } from 'bun:test'

// 模块里缓存着 AudioContext，所以 fake 必须在第一次 play 之前装好。
function fakeAudio({ state = 'running' } = {}) {
  const started = []
  const context = {
    state,
    currentTime: 10,
    destination: { kind: 'destination' },
    resume: async () => {
      context.state = 'running'
    },
    createOscillator() {
      const oscillator = {
        type: 'sine',
        frequency: { setValueAtTime: (value, at) => started.push({ value, at }) },
        connect() {},
        start(at) {
          oscillator.startedAt = at
        },
        stop() {}
      }
      return oscillator
    },
    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          exponentialRampToValueAtTime() {}
        },
        connect() {}
      }
    }
  }
  return { context, started }
}

beforeEach(() => {
  delete globalThis.webkitAudioContext
})

describe('notification sound', () => {
  it('plays one oscillator per tone of the requested kind', async () => {
    const { context, started } = fakeAudio()
    globalThis.AudioContext = function AudioContext() {
      return context
    }
    const { NOTIFICATION_TONES, playNotification } = await import(
      `./notification-sound.js?case=${Math.random()}`
    )
    await playNotification('ask')
    expect(started).toHaveLength(NOTIFICATION_TONES.ask.length)
    // 第二段动机与「做完了」不同，听感上要能区分开。
    expect(NOTIFICATION_TONES.ask[0].frequency).not.toBe(NOTIFICATION_TONES.completed[0].frequency)
  })

  it('stays silent for an unknown kind', async () => {
    const { context, started } = fakeAudio()
    globalThis.AudioContext = function AudioContext() {
      return context
    }
    const { playNotification } = await import(`./notification-sound.js?case=${Math.random()}`)
    await playNotification('nope')
    expect(started).toHaveLength(0)
  })
})
