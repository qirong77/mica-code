import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { turnLogVisible } from './chat-process-layout'

describe('turn log visibility', () => {
  it('keeps interrupted activity available', () => {
    expect(turnLogVisible({ roundCount: 1, running: false, interrupted: true })).toBe(true)
    expect(turnLogVisible({ roundCount: 0, running: false, interrupted: true })).toBe(false)
  })

  it('shows running activity, including before the first event', () => {
    expect(turnLogVisible({ roundCount: 0, running: true })).toBe(true)
    expect(turnLogVisible({ roundCount: 1, running: true })).toBe(true)
  })

  it('hides normally completed activity', () => {
    expect(turnLogVisible({ roundCount: 1, running: false, interrupted: false })).toBe(false)
    expect(turnLogVisible({ roundCount: 0, running: false })).toBe(false)
  })

  it('keeps the log between the transcript and composer without a floating layout', () => {
    const view = readFileSync(new URL('./ChatView.jsx', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../assets/app.css', import.meta.url), 'utf8')
    const transcript = view.indexOf('<div ref={transcriptRef}')
    const log = view.indexOf('<TurnLogDock', transcript)
    const composer = view.indexOf('<div ref={composerDockRef}', log)
    expect(transcript).toBeGreaterThan(-1)
    expect(log).toBeGreaterThan(transcript)
    expect(composer).toBeGreaterThan(log)
    expect(view).toContain('<TodoDock panel={todoPanel} />')
    expect(view).not.toMatch(/useProcessLayout|processSidebar|onTogglePlacement/)
    expect(css).not.toMatch(/has-process-sidebar|chat-turn-log\.is-sidebar|chat-process-placement/)
  })
})
