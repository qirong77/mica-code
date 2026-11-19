import { afterEach, describe, expect, it } from 'bun:test'
import { pasteIntoComposer } from './composer-paste'

const originalWindow = globalThis.window

afterEach(() => {
  globalThis.window = originalWindow
})

function imagePasteEvent() {
  const file = { name: 'screenshot.png', size: 12, type: 'image/png' }
  let prevented = false
  return {
    event: {
      clipboardData: {
        files: [file],
        items: [{ type: file.type, getAsFile: () => file }],
        getData: () => ''
      },
      preventDefault: () => {
        prevented = true
      }
    },
    wasPrevented: () => prevented
  }
}

describe('pasteIntoComposer image feedback', () => {
  it('reports image processing around the async save and insertion', async () => {
    let resolveSave
    globalThis.window = {
      mica: {
        chat: {
          savePastedImage: () =>
            new Promise((resolve) => {
              resolveSave = resolve
            })
        }
      }
    }
    const { event, wasPrevented } = imagePasteEvent()
    const events = []
    const inserted = []
    const paste = pasteIntoComposer(event, {
      insertText: (text) => {
        events.push('insert')
        inserted.push(text)
      },
      onImagePasteStart: () => events.push('start'),
      onImagePasteEnd: () => events.push('end')
    })

    expect(wasPrevented()).toBe(true)
    expect(events).toEqual(['start'])

    resolveSave({ ok: true, ref: '/tmp/screenshot.png' })
    await paste

    expect(events).toEqual(['start', 'insert', 'end'])
    expect(inserted).toEqual(['[Image](/tmp/screenshot.png)'])
  })

  it('ends image processing feedback when saving fails', async () => {
    globalThis.window = {
      mica: {
        chat: {
          savePastedImage: async () => {
            throw new Error('disk full')
          }
        }
      }
    }
    const { event } = imagePasteEvent()
    const events = []

    await pasteIntoComposer(event, {
      onImagePasteStart: () => events.push('start'),
      onImagePasteEnd: () => events.push('end')
    })

    expect(events).toEqual(['start', 'end'])
  })
})
