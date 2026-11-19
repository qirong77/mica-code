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
    const bottomDock = view.indexOf('<div ref={composerDockRef} className="chat-bottom-dock">', transcript)
    const log = view.indexOf('<TurnLogDock', bottomDock)
    const composer = view.indexOf('<div className="chat-composer-dock">', log)
    expect(transcript).toBeGreaterThan(-1)
    expect(bottomDock).toBeGreaterThan(transcript)
    expect(log).toBeGreaterThan(transcript)
    expect(composer).toBeGreaterThan(log)
    expect(css).toMatch(/\.chat-bottom-dock\s*\{[\s\S]*?display:\s*flex;/)
    expect(css).toMatch(/\.chat-bottom-scroll\s*\{[\s\S]*?overflow-y:\s*auto;/)
    expect(css).toMatch(/\.chat-bottom-dock\s*\{[\s\S]*?overflow:\s*visible;/)
    expect(view).toContain('ref={bottomScrollRef} className="chat-bottom-scroll"')
    expect(view).toContain('scroll.scrollTop = scroll.scrollHeight')
    // TODO panel may carry a turn-scoped key so its local collapse state resets
    // when the active turn changes; the layout contract only needs the panel.
    expect(view).toMatch(/<TodoDock(?: key=.*?)? panel=\{todoPanel\} \/>/)
    expect(view).not.toMatch(/useProcessLayout|processSidebar|onTogglePlacement/)
    expect(css).not.toMatch(/has-process-sidebar|chat-turn-log\.is-sidebar|chat-process-placement/)
  })
})
