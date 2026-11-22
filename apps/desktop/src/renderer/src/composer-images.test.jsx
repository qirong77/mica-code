import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ComposerImageStrip } from './composer-images'

describe('ComposerImageStrip', () => {
  it('shows an animated processing placeholder before the image reference exists', () => {
    const html = renderToStaticMarkup(
      createElement(ComposerImageStrip, { text: '', pending: true })
    )

    expect(html).toContain('chat-composer-images')
    expect(html).toContain('chat-composer-image-pending')
    expect(html).toContain('chat-composer-image-pending-icon')
    expect(html).toContain('正在处理图片…')
    expect(html).toContain('aria-busy="true"')
  })

  it('does not add a strip when there is no image or pending work', () => {
    expect(renderToStaticMarkup(createElement(ComposerImageStrip, { text: '' }))).toBe('')
  })

  it('shows acknowledged upload progress for an attachment before a reference exists', () => {
    const html = renderToStaticMarkup(
      createElement(ComposerImageStrip, {
        text: '',
        uploads: [{ name: 'photo.jpg', loaded: 512, total: 1024, phase: 'uploading' }]
      })
    )
    expect(html).toContain('正在上传附件… 50%')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('title="photo.jpg"')
  })
})
