import { describe, expect, it } from 'bun:test'
import { createElement, Suspense } from 'react'
import { renderToPipeableStream } from 'react-dom/server'
import { PassThrough } from 'node:stream'
import { deferredPluginPage } from './plugin-entries.js'

async function render(Component) {
  const chunks = []
  const output = new PassThrough()
  output.on('data', (chunk) => chunks.push(chunk))
  const completed = new Promise((resolve, reject) => {
    output.on('end', () => resolve(Buffer.concat(chunks).toString()))
    output.on('error', reject)
  })
  const stream = renderToPipeableStream(
    createElement(Suspense, { fallback: 'loading' }, createElement(Component)),
    {
      onAllReady() {
        stream.pipe(output)
      },
      onError(error) {
        output.destroy(error)
      }
    }
  )
  return completed
}

describe('manifest-only plugin page entries', () => {
  it('does not fetch a heavy page when creating its entry, and shares the component across entry locations', async () => {
    let loads = 0
    const loader = async () => {
      loads += 1
      return { Page: () => createElement('p', null, 'heavy page opened') }
    }
    const entry = deferredPluginPage('deferred-page-test', loader)
    expect(loads).toBe(0)
    expect(deferredPluginPage('deferred-page-test', loader)).toBe(entry)
    expect(await render(entry.Page)).toContain('heavy page opened')
    expect(loads).toBe(1)
    expect(await render(entry.Page)).toContain('heavy page opened')
    expect(loads).toBe(1)
  })

  it('supports a page exported as default without eagerly loading it', async () => {
    let loaded = false
    const entry = deferredPluginPage('default-page-test', async () => {
      loaded = true
      return { default: () => createElement('p', null, 'default page') }
    })
    expect(loaded).toBe(false)
    expect(await render(entry.Page)).toContain('default page')
    expect(loaded).toBe(true)
  })
})
