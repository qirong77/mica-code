// 提示音：现场合成，不带音频文件。
//
// 打包不必背音效资源，音量与时长都在这里定。两种场合用两段不同的动机，听一耳朵就知道
// 是「做完了」还是「有个问题在等你选」。
//
// AudioContext 懒建：浏览器/Electron 要求先有一次用户手势才能出声，App 在第一次
// pointerdown / keydown 时调 `unlockAudio()` 把它唤醒；唤醒之前调用 play 只会静默返回。

let context = null

export function audioContext() {
  if (context) return context
  const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext
  if (AudioContext) context = new AudioContext()
  return context
}

export function unlockAudio() {
  const current = audioContext()
  if (current?.state === 'suspended') current.resume().catch(() => {})
}

/**
 * 一段提示音的音符表：`offset` 是相对起点的秒数，`duration` 是这一声的长度，
 * `volume` 是峰值（相对满幅的量级，别超过 0.1，否则在耳机里很刺）。
 */
export const NOTIFICATION_TONES = {
  // 一轮结束：两声上行（E5 → A5），收工的感觉。
  completed: [
    { frequency: 659.25, offset: 0, duration: 0.11, volume: 0.055 },
    { frequency: 880, offset: 0.1, duration: 0.16, volume: 0.06 }
  ],
  // 有个问题在等用户选：A5 → D5 下行再重复一遍。与「做完了」正好反过来，
  // 两遍是为了它能盖过正在放的音乐、又不至于长到烦人。
  ask: [
    { frequency: 987.77, offset: 0, duration: 0.09, volume: 0.06 },
    { frequency: 659.25, offset: 0.11, duration: 0.12, volume: 0.06 },
    { frequency: 987.77, offset: 0.27, duration: 0.09, volume: 0.06 },
    { frequency: 659.25, offset: 0.38, duration: 0.15, volume: 0.06 }
  ]
}

export async function playNotification(kind) {
  const tones = NOTIFICATION_TONES[kind]
  if (!tones) return
  const current = audioContext()
  if (!current) return
  if (current.state === 'suspended') await current.resume()
  if (current.state !== 'running') return
  const start = current.currentTime + 0.015
  for (const tone of tones) {
    const from = start + tone.offset
    const to = from + tone.duration
    const oscillator = current.createOscillator()
    const gain = current.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(tone.frequency, from)
    gain.gain.setValueAtTime(0.0001, from)
    gain.gain.exponentialRampToValueAtTime(tone.volume, from + 0.018)
    gain.gain.exponentialRampToValueAtTime(0.0001, to)
    oscillator.connect(gain)
    gain.connect(current.destination)
    oscillator.start(from)
    oscillator.stop(to + 0.01)
  }
}

